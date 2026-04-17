package realtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"

	"oopz/internal/auth"
	"oopz/internal/models"
	"oopz/internal/store"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type Client struct {
	conn             *websocket.Conn
	hub              *Hub
	send             chan []byte
	user             models.User
	domainID         int64
	currentChannelID int64
	currentScreeningChannelID int64
	micEnabled       bool
	screenSharing    bool
}

type Hub struct {
	store          *store.Store
	rdb            *redis.Client
	auth           *auth.TokenManager
	mu             sync.RWMutex
	clients        map[*Client]struct{}
	userClients    map[int64]map[*Client]struct{}
	channelClients map[int64]map[*Client]struct{}
	channelUsers   map[int64]map[int64]*PresenceMember
	screeningClients map[int64]map[*Client]struct{}
	domainUsers    map[int64]*OnlineUserPresence
}

func NewHub(s *store.Store, rdb *redis.Client, authManager *auth.TokenManager) *Hub {
	return &Hub{
		store:          s,
		rdb:            rdb,
		auth:           authManager,
		clients:        map[*Client]struct{}{},
		userClients:    map[int64]map[*Client]struct{}{},
		channelClients: map[int64]map[*Client]struct{}{},
		channelUsers:   map[int64]map[int64]*PresenceMember{},
		screeningClients: map[int64]map[*Client]struct{}{},
		domainUsers:    map[int64]*OnlineUserPresence{},
	}
}

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) error {
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		return fmt.Errorf("missing token")
	}
	userID, err := h.auth.Parse(token)
	if err != nil {
		return fmt.Errorf("invalid token")
	}
	domainID, err := strconv.ParseInt(r.URL.Query().Get("domainId"), 10, 64)
	if err != nil || domainID == 0 {
		return fmt.Errorf("invalid domainId")
	}

	user, err := h.store.GetUserByID(userID)
	if err != nil {
		return err
	}
	if err := h.store.EnsureDomainMembership(domainID, userID, "member"); err != nil {
		return err
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return err
	}

	client := &Client{
		conn:          conn,
		hub:           h,
		send:          make(chan []byte, 64),
		user:          user,
		domainID:      domainID,
		micEnabled:    true,
		screenSharing: false,
	}

	h.register(client)
	go client.writePump()
	go client.readPump()
	client.sendJSON("ready", map[string]any{
		"userId":   user.ID,
		"domainId": domainID,
	})
	return nil
}

func (h *Hub) register(client *Client) {
	h.mu.Lock()
	h.clients[client] = struct{}{}
	if _, ok := h.userClients[client.user.ID]; !ok {
		h.userClients[client.user.ID] = map[*Client]struct{}{}
	}
	h.userClients[client.user.ID][client] = struct{}{}
	state := h.refreshDomainUserLocked(client.user.ID)
	h.mu.Unlock()

	h.persistDomainUser(state)
}

func (h *Hub) unregister(client *Client) {
	h.leaveChannel(client, true)
	h.leaveScreening(client, client.currentScreeningChannelID)

	h.mu.Lock()
	delete(h.clients, client)
	if group, ok := h.userClients[client.user.ID]; ok {
		delete(group, client)
		if len(group) == 0 {
			delete(h.userClients, client.user.ID)
		}
	}
	remainingClients := len(h.userClients[client.user.ID])
	state := h.refreshDomainUserLocked(client.user.ID)
	h.mu.Unlock()

	if remainingClients == 0 {
		h.removeUserFromAllVoiceChannels(client.user.ID, 0)
		h.removeUserFromAllScreeningRooms(client.user.ID, 0)
	}
	if state == nil {
		h.removeDomainUser(client.user.ID)
	} else {
		h.persistDomainUser(state)
	}
	close(client.send)
}

func (h *Hub) OnlineCounts(channelIDs []int64) map[string]int64 {
	result := make(map[string]int64, len(channelIDs))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	for _, id := range channelIDs {
		count, err := h.rdb.HLen(ctx, h.presenceKey(id)).Result()
		if err != nil {
			log.Printf("redis hlen error: %v", err)
			continue
		}
		result[strconv.FormatInt(id, 10)] = count
	}
	return result
}

func (h *Hub) DomainPresence(domainID int64, voiceChannelIDs []int64, screeningChannelIDs []int64) DomainPresenceSnapshot {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	result := DomainPresenceSnapshot{
		OnlineUsers:      []OnlineUserPresence{},
		VoiceMembers:     map[string][]PresenceMember{},
		ScreeningMembers: map[string][]models.ScreeningViewer{},
		OnlineCounts:     map[string]int64{},
	}

	if onlineUsers, err := h.rdb.HGetAll(ctx, h.domainOnlineKey()).Result(); err == nil {
		for _, raw := range onlineUsers {
			var item OnlineUserPresence
			if json.Unmarshal([]byte(raw), &item) == nil {
				result.OnlineUsers = append(result.OnlineUsers, item)
			}
		}
	} else {
		log.Printf("redis hgetall online users error: %v", err)
	}

	for _, channelID := range voiceChannelIDs {
		key := h.presenceKey(channelID)
		presenceMap, err := h.rdb.HGetAll(ctx, key).Result()
		if err != nil {
			log.Printf("redis hgetall presence error: %v", err)
			continue
		}
		members := make([]PresenceMember, 0, len(presenceMap))
		for _, raw := range presenceMap {
			var member PresenceMember
			if json.Unmarshal([]byte(raw), &member) == nil {
				members = append(members, member)
			}
		}
		result.VoiceMembers[strconv.FormatInt(channelID, 10)] = members
		result.OnlineCounts[strconv.FormatInt(channelID, 10)] = int64(len(members))
	}

	for _, channelID := range screeningChannelIDs {
		viewers, err := h.loadScreeningViewers(channelID)
		if err != nil {
			log.Printf("redis screening viewers error: %v", err)
			continue
		}
		result.ScreeningMembers[strconv.FormatInt(channelID, 10)] = viewers
	}

	return result
}

func (h *Hub) Handle(client *Client, raw []byte) {
	var envelope struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		client.sendJSON("error", map[string]string{"message": "invalid payload"})
		return
	}

	switch envelope.Type {
	case "channel.join":
		eventStartedAt := time.Now()
		var payload ChannelJoinPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid channel.join payload"})
			return
		}
		log.Printf("[voice-backend] channel.join received user=%d domain=%d channel=%d current=%d", client.user.ID, client.domainID, payload.ChannelID, client.currentChannelID)
		if err := h.joinChannel(client, payload.ChannelID); err != nil {
			client.sendJSON("error", map[string]string{"message": err.Error()})
			log.Printf("[voice-backend] channel.join failed user=%d channel=%d err=%v elapsed_ms=%d", client.user.ID, payload.ChannelID, err, time.Since(eventStartedAt).Milliseconds())
		} else {
			log.Printf("[voice-backend] channel.join completed user=%d channel=%d elapsed_ms=%d", client.user.ID, payload.ChannelID, time.Since(eventStartedAt).Milliseconds())
		}
	case "channel.leave":
		eventStartedAt := time.Now()
		log.Printf("[voice-backend] channel.leave received user=%d domain=%d channel=%d", client.user.ID, client.domainID, client.currentChannelID)
		h.leaveChannel(client, true)
		log.Printf("[voice-backend] channel.leave completed user=%d elapsed_ms=%d", client.user.ID, time.Since(eventStartedAt).Milliseconds())
	case "chat.send":
		var payload ChatSendPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid chat payload"})
			return
		}
		if strings.TrimSpace(payload.Body) == "" {
			return
		}
		h.handleChat(client, payload)
	case "voice.state":
		var payload VoiceStatePayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid voice payload"})
			return
		}
		h.handleVoiceState(client, payload)
	case "screen.state":
		var payload ScreenStatePayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid screen payload"})
			return
		}
		h.handleScreenState(client, payload)
	case "screening.join":
		var payload ScreeningJoinPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid screening.join payload"})
			return
		}
		if err := h.joinScreening(client, payload.ChannelID); err != nil {
			client.sendJSON("error", map[string]string{"message": err.Error()})
		}
	case "screening.leave":
		var payload ScreeningLeavePayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid screening.leave payload"})
			return
		}
		h.leaveScreening(client, payload.ChannelID)
	case "screening.url.replace":
		var payload ScreeningReplacePayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid screening.url.replace payload"})
			return
		}
		if err := h.replaceScreeningURL(client, payload); err != nil {
			client.sendJSON("error", map[string]string{"message": err.Error()})
		}
	case "screening.url.add":
		var payload ScreeningAddPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid screening.url.add payload"})
			return
		}
		if err := h.addScreeningURL(client, payload); err != nil {
			client.sendJSON("error", map[string]string{"message": err.Error()})
		}
	case "screening.controller.ready":
		var payload ScreeningPlaybackPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid screening.controller.ready payload"})
			return
		}
		if err := h.updateScreeningPlayback(client, "screening.play", payload, true); err != nil {
			client.sendJSON("error", map[string]string{"message": err.Error()})
		}
	case "screening.play":
		var payload ScreeningPlaybackPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid screening.play payload"})
			return
		}
		if err := h.updateScreeningPlayback(client, "screening.play", payload, false); err != nil {
			client.sendJSON("error", map[string]string{"message": err.Error()})
		}
	case "screening.pause":
		var payload ScreeningPlaybackPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid screening.pause payload"})
			return
		}
		if err := h.updateScreeningPlayback(client, "screening.pause", payload, false); err != nil {
			client.sendJSON("error", map[string]string{"message": err.Error()})
		}
	case "screening.seek":
		var payload ScreeningPlaybackPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid screening.seek payload"})
			return
		}
		if err := h.updateScreeningPlayback(client, "screening.seek", payload, false); err != nil {
			client.sendJSON("error", map[string]string{"message": err.Error()})
		}
	case "screening.tick":
		var payload ScreeningPlaybackPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid screening.tick payload"})
			return
		}
		if err := h.updateScreeningPlayback(client, "screening.tick", payload, false); err != nil {
			client.sendJSON("error", map[string]string{"message": err.Error()})
		}
	case "screening.rate":
		var payload ScreeningPlaybackPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid screening.rate payload"})
			return
		}
		if err := h.updateScreeningPlayback(client, "screening.rate", payload, false); err != nil {
			client.sendJSON("error", map[string]string{"message": err.Error()})
		}
	case "screening.item.ended":
		var payload ScreeningPlaybackPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid screening.item.ended payload"})
			return
		}
		if err := h.advanceScreeningPlaylist(client, payload.ChannelID); err != nil {
			client.sendJSON("error", map[string]string{"message": err.Error()})
		}
	case "rtc.offer", "rtc.answer", "rtc.ice_candidate", "rtc.reset", "screen.sync_request", "media.sync_request":
		var payload RTCSignalPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid rtc payload"})
			return
		}
		payload.SourceUserID = client.user.ID
		h.forwardToUser(payload.TargetUserID, envelope.Type, payload)
	case "heartbeat", "hello":
		client.sendJSON("ready", map[string]any{
			"userId":   client.user.ID,
			"domainId": client.domainID,
		})
	default:
		client.sendJSON("error", map[string]string{"message": "unknown event"})
	}
}

func (h *Hub) handleChat(client *Client, payload ChatSendPayload) {
	msg, err := h.store.InsertMessage(client.domainID, payload.ChannelID, &client.user.ID, "chat", strings.TrimSpace(payload.Body), nil)
	if err != nil {
		client.sendJSON("error", map[string]string{"message": "message persist failed"})
		return
	}
	h.broadcastToDomain(client.domainID, "chat.message", msg, nil)
}

func (h *Hub) handleVoiceState(client *Client, payload VoiceStatePayload) {
	client.micEnabled = payload.MicEnabled
	h.updatePresence(client)
	h.broadcastToChannel(payload.ChannelID, "voice.state", map[string]any{
		"channelId":  payload.ChannelID,
		"userId":     client.user.ID,
		"micEnabled": payload.MicEnabled,
	}, nil)
}

func (h *Hub) handleScreenState(client *Client, payload ScreenStatePayload) {
	client.screenSharing = payload.ScreenSharing
	h.updatePresence(client)
	h.broadcastToChannel(payload.ChannelID, "screen.state", map[string]any{
		"channelId":     payload.ChannelID,
		"userId":        client.user.ID,
		"screenSharing": payload.ScreenSharing,
	}, nil)
}

func (h *Hub) joinChannel(client *Client, channelID int64) error {
	channel, err := h.store.GetChannel(channelID)
	if err != nil {
		return err
	}
	if channel == nil {
		return fmt.Errorf("channel not found")
	}
	if channel.Type != "voice" && channel.Type != "screening" {
		return fmt.Errorf("only voice or screening channels can be joined")
	}

	if client.currentChannelID == channelID {
		return nil
	}
	h.removeUserFromAllVoiceChannels(client.user.ID, channelID)
	if client.currentChannelID != 0 {
		h.leaveChannel(client, true)
	}

	member := &PresenceMember{
		User:          client.user,
		ChannelID:     channelID,
		MicEnabled:    client.micEnabled,
		ScreenSharing: client.screenSharing,
	}

	h.mu.Lock()
	client.currentChannelID = channelID
	if _, ok := h.channelClients[channelID]; !ok {
		h.channelClients[channelID] = map[*Client]struct{}{}
	}
	h.channelClients[channelID][client] = struct{}{}
	if _, ok := h.channelUsers[channelID]; !ok {
		h.channelUsers[channelID] = map[int64]*PresenceMember{}
	}
	h.channelUsers[channelID][client.user.ID] = member

	snapshot := make([]PresenceMember, 0, len(h.channelUsers[channelID]))
	for _, current := range h.channelUsers[channelID] {
		snapshot = append(snapshot, *current)
	}
	h.mu.Unlock()
	h.persistPresence(channelID, member)
	h.persistDomainUser(h.snapshotOnlineUser(client))
	client.sendJSON("presence.snapshot", map[string]any{
		"channelId": channelID,
		"members":   snapshot,
	})
	h.broadcastToChannel(channelID, "member.joined", member, client)
	h.broadcastTransientSystem(client, channelID, fmt.Sprintf("%s joined the room", client.user.DisplayName))
	return nil
}

func (h *Hub) leaveChannel(client *Client, persist bool) {
	h.mu.Lock()
	channelID := client.currentChannelID
	if channelID == 0 {
		h.mu.Unlock()
		return
	}

	delete(h.channelClients[channelID], client)
	if len(h.channelClients[channelID]) == 0 {
		delete(h.channelClients, channelID)
	}
	if users, ok := h.channelUsers[channelID]; ok {
		delete(users, client.user.ID)
		if len(users) == 0 {
			delete(h.channelUsers, channelID)
		}
	}
	client.currentChannelID = 0
	state := h.refreshDomainUserLocked(client.user.ID)
	h.mu.Unlock()
	h.removePresence(channelID, client.user.ID)
	if state == nil {
		h.removeDomainUser(client.user.ID)
	} else {
		h.persistDomainUser(state)
	}
	h.broadcastToChannel(channelID, "member.left", map[string]any{
		"channelId": channelID,
		"userId":    client.user.ID,
	}, nil)
	if persist {
		h.broadcastTransientSystem(client, channelID, fmt.Sprintf("%s left the room", client.user.DisplayName))
	}
}

func (h *Hub) joinScreening(client *Client, channelID int64) error {
	log.Printf("[screening-backend] join channel=%d user=%d current=%d", channelID, client.user.ID, client.currentScreeningChannelID)
	channel, err := h.store.GetChannel(channelID)
	if err != nil {
		return err
	}
	if channel == nil {
		return fmt.Errorf("channel not found")
	}
	if channel.Type != "screening" {
		return fmt.Errorf("only screening channels can be joined")
	}
	if client.currentScreeningChannelID == channelID {
		snapshot, err := h.loadScreeningSnapshot(channelID)
		if err != nil {
			return err
		}
		log.Printf("[screening-backend] join snapshot-direct channel=%d user=%d item=%s url=%s controller=%d viewers=%d", channelID, client.user.ID, snapshot.State.CurrentItemID, snapshot.State.CurrentURL, snapshot.State.ControllerUserID, len(snapshot.Viewers))
		client.sendJSON("screening.snapshot", snapshot)
		return nil
	}
	h.removeUserFromAllScreeningRooms(client.user.ID, channelID)
	if client.currentScreeningChannelID != 0 {
		h.leaveScreening(client, client.currentScreeningChannelID)
	}

	h.mu.Lock()
	client.currentScreeningChannelID = channelID
	if _, ok := h.screeningClients[channelID]; !ok {
		h.screeningClients[channelID] = map[*Client]struct{}{}
	}
	h.screeningClients[channelID][client] = struct{}{}
	h.mu.Unlock()

	if err := h.upsertScreeningViewer(channelID, models.ScreeningViewer{
		User:       client.user,
		Ready:      false,
		JoinedAt:   time.Now().UTC(),
		LastPingAt: time.Now().UTC(),
	}); err != nil {
		return err
	}
	state, err := h.loadOrInitScreeningState(channelID, client.user.ID)
	if err != nil {
		return err
	}
	if err := h.saveScreeningState(channelID, state); err != nil {
		return err
	}
	log.Printf("[screening-backend] join state-ready channel=%d user=%d item=%s url=%s controller=%d", channelID, client.user.ID, state.CurrentItemID, state.CurrentURL, state.ControllerUserID)
	return h.broadcastScreeningSnapshot(channelID)
}

func (h *Hub) leaveScreening(client *Client, channelID int64) {
	if channelID == 0 {
		return
	}
	h.mu.Lock()
	if clients, ok := h.screeningClients[channelID]; ok {
		delete(clients, client)
		if len(clients) == 0 {
			delete(h.screeningClients, channelID)
		}
	}
	if client.currentScreeningChannelID == channelID {
		client.currentScreeningChannelID = 0
	}
	h.mu.Unlock()

	viewers, err := h.removeScreeningViewer(channelID, client.user.ID)
	if err != nil {
		log.Printf("screening remove viewer error: %v", err)
		return
	}
	if len(viewers) == 0 {
		log.Printf("[screening-backend] leave clear channel=%d user=%d", channelID, client.user.ID)
		h.clearScreeningRoom(channelID)
		return
	}
	nextController := viewers[rand.Intn(len(viewers))].User.ID
	state, err := h.loadOrInitScreeningState(channelID, nextController)
	if err == nil && state.ControllerUserID == client.user.ID {
		previousControllerID := state.ControllerUserID
		state.ControllerUserID = nextController
		state.UpdatedAt = time.Now().UTC()
		_ = h.saveScreeningState(channelID, state)
		nextControllerName := ""
		for _, viewer := range viewers {
			if viewer.User.ID == nextController {
				nextControllerName = viewer.User.DisplayName
				break
			}
		}
		log.Printf("[screening-backend] controller-transfer channel=%d previous=%d next=%d item=%s url=%s", channelID, previousControllerID, nextController, state.CurrentItemID, state.CurrentURL)
		h.broadcastToScreening(channelID, "screening.controller.changed", map[string]any{
			"channelId":              channelID,
			"previousControllerId":   previousControllerID,
			"previousControllerName": client.user.DisplayName,
			"controllerUserId":       nextController,
			"controllerName":         nextControllerName,
		}, nil)
	}
	_ = h.broadcastScreeningSnapshot(channelID)
}

func (h *Hub) removeUserFromAllVoiceChannels(userID, exceptChannelID int64) {
	var staleChannels []int64

	h.mu.Lock()
	for channelID, users := range h.channelUsers {
		if channelID == exceptChannelID {
			continue
		}
		if _, ok := users[userID]; !ok {
			continue
		}
		delete(users, userID)
		if len(users) == 0 {
			delete(h.channelUsers, channelID)
		}
		if clients, ok := h.channelClients[channelID]; ok {
			for client := range clients {
				if client.user.ID != userID {
					continue
				}
				delete(clients, client)
				if client.currentChannelID == channelID {
					client.currentChannelID = 0
				}
			}
			if len(clients) == 0 {
				delete(h.channelClients, channelID)
			}
		}
		staleChannels = append(staleChannels, channelID)
	}
	state := h.refreshDomainUserLocked(userID)
	h.mu.Unlock()

	for _, channelID := range staleChannels {
		log.Printf("[voice-backend] cleanup stale voice membership user=%d removed_channel=%d keep_channel=%d", userID, channelID, exceptChannelID)
		h.removePresence(channelID, userID)
		h.broadcastToChannel(channelID, "member.left", map[string]any{
			"channelId": channelID,
			"userId":    userID,
		}, nil)
	}
	if state == nil {
		h.removeDomainUser(userID)
	} else {
		h.persistDomainUser(state)
	}
}

func (h *Hub) removeUserFromAllScreeningRooms(userID, exceptChannelID int64) {
	var staleChannels []int64

	h.mu.Lock()
	for channelID, clients := range h.screeningClients {
		if channelID == exceptChannelID {
			continue
		}
		removed := false
		for client := range clients {
			if client.user.ID != userID {
				continue
			}
			delete(clients, client)
			if client.currentScreeningChannelID == channelID {
				client.currentScreeningChannelID = 0
			}
			removed = true
		}
		if len(clients) == 0 {
			delete(h.screeningClients, channelID)
		}
		if removed {
			staleChannels = append(staleChannels, channelID)
		}
	}
	h.mu.Unlock()

	for _, channelID := range staleChannels {
		log.Printf("[screening-backend] cleanup stale screening membership user=%d removed_channel=%d keep_channel=%d", userID, channelID, exceptChannelID)
		viewers, err := h.removeScreeningViewer(channelID, userID)
		if err != nil {
			log.Printf("screening stale cleanup error: %v", err)
			continue
		}
		if len(viewers) == 0 {
			h.clearScreeningRoom(channelID)
			continue
		}
		_ = h.broadcastScreeningSnapshot(channelID)
	}
}

func (h *Hub) replaceScreeningURL(client *Client, payload ScreeningReplacePayload) error {
	if payload.ChannelID == 0 || strings.TrimSpace(payload.URL) == "" {
		return fmt.Errorf("channelId and url are required")
	}
	state, err := h.loadOrInitScreeningState(payload.ChannelID, client.user.ID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	state.ControllerUserID = client.user.ID
	state.CurrentItemID = fmt.Sprintf("%d-%d", client.user.ID, now.UnixMilli())
	state.CurrentURL = strings.TrimSpace(payload.URL)
	state.CurrentTitle = strings.TrimSpace(payload.Title)
	state.PlaybackState = "loading"
	state.CurrentTime = 0
	state.PlaybackRate = 1
	state.UpdatedAt = now
	state.StartedAt = time.Time{}
	state.AwaitingReady = true
	state.SyncToken++
	if err := h.saveScreeningState(payload.ChannelID, state); err != nil {
		return err
	}
	if err := h.resetScreeningViewerReady(payload.ChannelID); err != nil {
		return err
	}
	return h.broadcastScreeningSnapshot(payload.ChannelID)
}

func (h *Hub) addScreeningURL(client *Client, payload ScreeningAddPayload) error {
	if payload.ChannelID == 0 || strings.TrimSpace(payload.URL) == "" {
		return fmt.Errorf("channelId and url are required")
	}
	item := models.ScreeningPlaylistItem{
		ItemID:  fmt.Sprintf("%d-%d", client.user.ID, time.Now().UTC().UnixMilli()),
		URL:     strings.TrimSpace(payload.URL),
		Title:   strings.TrimSpace(payload.Title),
		AddedBy: client.user.ID,
		AddedAt: time.Now().UTC(),
	}
	if err := h.pushScreeningPlaylistItem(payload.ChannelID, item); err != nil {
		return err
	}
	playlist, err := h.loadScreeningPlaylist(payload.ChannelID)
	if err != nil {
		return err
	}
	h.broadcastToScreening(payload.ChannelID, "screening.playlist.updated", map[string]any{
		"channelId": payload.ChannelID,
		"playlist":  playlist,
	}, nil)
	return nil
}

func (h *Hub) updateScreeningPlayback(client *Client, eventType string, payload ScreeningPlaybackPayload, readyOnly bool) error {
	if payload.ChannelID == 0 {
		return fmt.Errorf("channelId is required")
	}
	state, err := h.loadOrInitScreeningState(payload.ChannelID, client.user.ID)
	if err != nil {
		return err
	}
	if err := h.ensureScreeningController(client, state); err != nil {
		return err
	}
	now := time.Now().UTC()
	isLive := isLikelyLiveScreeningURL(state.CurrentURL)
	if payload.ItemID != "" && state.CurrentItemID != "" && payload.ItemID != state.CurrentItemID {
		return nil
	}
	state.ControllerUserID = client.user.ID

	if isLive {
		state.CurrentTime = 0
		state.PlaybackRate = 1
		state.UpdatedAt = now
		switch eventType {
		case "screening.play":
			state.PlaybackState = "playing"
			state.AwaitingReady = false
			state.StartedAt = time.Time{}
		case "screening.pause":
			state.PlaybackState = "paused"
		case "screening.seek", "screening.tick", "screening.rate":
			return nil
		}
		if readyOnly {
			state.PlaybackState = "playing"
			state.AwaitingReady = false
			state.CurrentTime = 0
			state.StartedAt = time.Time{}
			if err := h.markScreeningViewerReady(payload.ChannelID, client.user.ID); err != nil {
				return err
			}
		}
		if err := h.saveScreeningState(payload.ChannelID, state); err != nil {
			return err
		}
		h.broadcastToScreening(payload.ChannelID, eventType, state, nil)
		return nil
	}

	state.CurrentTime = payload.CurrentTime
	if payload.PlaybackRate > 0 {
		state.PlaybackRate = payload.PlaybackRate
	}
	if state.PlaybackRate <= 0 {
		state.PlaybackRate = 1
	}
	state.UpdatedAt = now
	switch eventType {
	case "screening.play":
		state.PlaybackState = "playing"
		state.AwaitingReady = false
		state.StartedAt = now.Add(-time.Duration((payload.CurrentTime/state.PlaybackRate)*float64(time.Second)))
	case "screening.pause":
		state.PlaybackState = "paused"
	case "screening.seek":
		if state.PlaybackState == "playing" {
			state.StartedAt = now.Add(-time.Duration((payload.CurrentTime/state.PlaybackRate)*float64(time.Second)))
		}
	case "screening.tick":
		if state.PlaybackState == "playing" {
			state.StartedAt = now.Add(-time.Duration((payload.CurrentTime/state.PlaybackRate)*float64(time.Second)))
		}
	case "screening.rate":
		if state.PlaybackState == "playing" {
			state.StartedAt = now.Add(-time.Duration((payload.CurrentTime/state.PlaybackRate)*float64(time.Second)))
		}
	}
	if readyOnly {
		state.PlaybackState = "playing"
		state.AwaitingReady = false
		state.CurrentTime = payload.CurrentTime
		state.StartedAt = now.Add(-time.Duration((payload.CurrentTime/state.PlaybackRate)*float64(time.Second)))
		if err := h.markScreeningViewerReady(payload.ChannelID, client.user.ID); err != nil {
			return err
		}
	}
	if err := h.saveScreeningState(payload.ChannelID, state); err != nil {
		return err
	}
	h.broadcastToScreening(payload.ChannelID, eventType, state, nil)
	return nil
}

func isLikelyLiveScreeningURL(raw string) bool {
	value := strings.TrimSpace(strings.ToLower(raw))
	if value == "" {
		return false
	}
	return strings.Contains(value, "live.bilibili.com") ||
		strings.Contains(value, ".m3u8") ||
		strings.Contains(value, ".flv") ||
		strings.Contains(value, "stream=live") ||
		strings.Contains(value, "livestream")
}

func (h *Hub) advanceScreeningPlaylist(client *Client, channelID int64) error {
	if channelID == 0 {
		return fmt.Errorf("channelId is required")
	}
	state, err := h.loadOrInitScreeningState(channelID, client.user.ID)
	if err != nil {
		return err
	}
	if err := h.ensureScreeningController(client, state); err != nil {
		return err
	}
	nextItem, ok, err := h.popNextScreeningPlaylistItem(channelID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if !ok {
		state.PlaybackState = "ended"
		state.CurrentTime = 0
		state.UpdatedAt = now
		state.AwaitingReady = false
		if err := h.saveScreeningState(channelID, state); err != nil {
			return err
		}
		return h.broadcastScreeningSnapshot(channelID)
	}
	state.CurrentItemID = nextItem.ItemID
	state.CurrentURL = nextItem.URL
	state.CurrentTitle = nextItem.Title
	state.PlaybackState = "loading"
	state.CurrentTime = 0
	state.PlaybackRate = 1
	state.UpdatedAt = now
	state.StartedAt = time.Time{}
	state.AwaitingReady = true
	state.SyncToken++
	if err := h.saveScreeningState(channelID, state); err != nil {
		return err
	}
	if err := h.resetScreeningViewerReady(channelID); err != nil {
		return err
	}
	return h.broadcastScreeningSnapshot(channelID)
}

func (h *Hub) updatePresence(client *Client) {
	if client.currentChannelID == 0 {
		return
	}

	h.mu.Lock()
	if users, ok := h.channelUsers[client.currentChannelID]; ok {
		if current, ok := users[client.user.ID]; ok {
			current.MicEnabled = client.micEnabled
			current.ScreenSharing = client.screenSharing
			h.persistPresence(client.currentChannelID, current)
		}
	}
	h.mu.Unlock()
}

func (h *Hub) persistPresence(channelID int64, member *PresenceMember) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	payload, _ := json.Marshal(member)
	if err := h.rdb.SAdd(ctx, "online:channels", channelID).Err(); err != nil {
		log.Printf("redis sadd error: %v", err)
	}
	if err := h.rdb.HSet(ctx, h.presenceKey(channelID), strconv.FormatInt(member.User.ID, 10), string(payload)).Err(); err != nil {
		log.Printf("redis hset error: %v", err)
	}
}

func (h *Hub) removePresence(channelID, userID int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if err := h.rdb.HDel(ctx, h.presenceKey(channelID), strconv.FormatInt(userID, 10)).Err(); err != nil {
		log.Printf("redis hdel error: %v", err)
	}
	count, err := h.rdb.HLen(ctx, h.presenceKey(channelID)).Result()
	if err != nil {
		log.Printf("redis hlen error: %v", err)
		return
	}
	if count == 0 {
		if err := h.rdb.SRem(ctx, "online:channels", channelID).Err(); err != nil {
			log.Printf("redis srem error: %v", err)
		}
	}
}

func (h *Hub) screeningStateKey(channelID int64) string {
	return fmt.Sprintf("screening:room:%d:state", channelID)
}

func (h *Hub) screeningViewersKey(channelID int64) string {
	return fmt.Sprintf("screening:room:%d:viewers", channelID)
}

func (h *Hub) screeningPlaylistKey(channelID int64) string {
	return fmt.Sprintf("screening:room:%d:playlist", channelID)
}

func (h *Hub) loadOrInitScreeningState(channelID, fallbackControllerID int64) (models.ScreeningState, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	values, err := h.rdb.HGetAll(ctx, h.screeningStateKey(channelID)).Result()
	if err != nil {
		return models.ScreeningState{}, err
	}
	if len(values) == 0 {
		now := time.Now().UTC()
		return models.ScreeningState{
			ChannelID:        channelID,
			ControllerUserID: fallbackControllerID,
			PlaybackState:    "idle",
			PlaybackRate:     1,
			UpdatedAt:        now,
		}, nil
	}

	state := models.ScreeningState{ChannelID: channelID}
	state.ControllerUserID, _ = strconv.ParseInt(values["controller_user_id"], 10, 64)
	state.CurrentItemID = values["current_item_id"]
	state.CurrentURL = values["current_url"]
	state.CurrentTitle = values["current_title"]
	state.PlaybackState = values["playback_state"]
	state.CurrentTime, _ = strconv.ParseFloat(values["current_time"], 64)
	state.PlaybackRate, _ = strconv.ParseFloat(values["playback_rate"], 64)
	state.SyncToken, _ = strconv.ParseInt(values["sync_token"], 10, 64)
	state.AwaitingReady = values["awaiting_ready"] == "1"
	if state.PlaybackRate <= 0 {
		state.PlaybackRate = 1
	}
	if updatedAt, err := time.Parse(time.RFC3339Nano, values["updated_at"]); err == nil {
		state.UpdatedAt = updatedAt
	}
	if startedAt, err := time.Parse(time.RFC3339Nano, values["started_at"]); err == nil {
		state.StartedAt = startedAt
	}
	if state.PlaybackState == "" {
		state.PlaybackState = "idle"
	}
	if state.ControllerUserID == 0 {
		state.ControllerUserID = fallbackControllerID
	}
	return state, nil
}

func (h *Hub) saveScreeningState(channelID int64, state models.ScreeningState) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	values := map[string]any{
		"controller_user_id": strconv.FormatInt(state.ControllerUserID, 10),
		"current_item_id":    state.CurrentItemID,
		"current_url":        state.CurrentURL,
		"current_title":      state.CurrentTitle,
		"playback_state":     state.PlaybackState,
		"current_time":       fmt.Sprintf("%.3f", state.CurrentTime),
		"playback_rate":      fmt.Sprintf("%.3f", state.PlaybackRate),
		"updated_at":         state.UpdatedAt.UTC().Format(time.RFC3339Nano),
		"started_at":         state.StartedAt.UTC().Format(time.RFC3339Nano),
		"awaiting_ready":     map[bool]string{true: "1", false: "0"}[state.AwaitingReady],
		"sync_token":         strconv.FormatInt(state.SyncToken, 10),
	}
	return h.rdb.HSet(ctx, h.screeningStateKey(channelID), values).Err()
}

func (h *Hub) upsertScreeningViewer(channelID int64, viewer models.ScreeningViewer) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	raw, err := json.Marshal(viewer)
	if err != nil {
		return err
	}
	return h.rdb.HSet(ctx, h.screeningViewersKey(channelID), strconv.FormatInt(viewer.User.ID, 10), string(raw)).Err()
}

func (h *Hub) loadScreeningViewers(channelID int64) ([]models.ScreeningViewer, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	items, err := h.rdb.HGetAll(ctx, h.screeningViewersKey(channelID)).Result()
	if err != nil {
		return nil, err
	}
	viewers := make([]models.ScreeningViewer, 0, len(items))
	for _, raw := range items {
		var viewer models.ScreeningViewer
		if json.Unmarshal([]byte(raw), &viewer) == nil {
			viewers = append(viewers, viewer)
		}
	}
	return viewers, nil
}

func (h *Hub) removeScreeningViewer(channelID, userID int64) ([]models.ScreeningViewer, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := h.rdb.HDel(ctx, h.screeningViewersKey(channelID), strconv.FormatInt(userID, 10)).Err(); err != nil {
		return nil, err
	}
	return h.loadScreeningViewers(channelID)
}

func (h *Hub) resetScreeningViewerReady(channelID int64) error {
	viewers, err := h.loadScreeningViewers(channelID)
	if err != nil {
		return err
	}
	for _, viewer := range viewers {
		viewer.Ready = false
		viewer.LastPingAt = time.Now().UTC()
		if err := h.upsertScreeningViewer(channelID, viewer); err != nil {
			return err
		}
	}
	return nil
}

func (h *Hub) markScreeningViewerReady(channelID, userID int64) error {
	viewers, err := h.loadScreeningViewers(channelID)
	if err != nil {
		return err
	}
	for _, viewer := range viewers {
		if viewer.User.ID != userID {
			continue
		}
		viewer.Ready = true
		viewer.LastPingAt = time.Now().UTC()
		return h.upsertScreeningViewer(channelID, viewer)
	}
	return nil
}

func (h *Hub) pushScreeningPlaylistItem(channelID int64, item models.ScreeningPlaylistItem) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	raw, err := json.Marshal(item)
	if err != nil {
		return err
	}
	return h.rdb.RPush(ctx, h.screeningPlaylistKey(channelID), string(raw)).Err()
}

func (h *Hub) loadScreeningPlaylist(channelID int64) ([]models.ScreeningPlaylistItem, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	items, err := h.rdb.LRange(ctx, h.screeningPlaylistKey(channelID), 0, -1).Result()
	if err != nil {
		return nil, err
	}
	playlist := make([]models.ScreeningPlaylistItem, 0, len(items))
	for _, raw := range items {
		var item models.ScreeningPlaylistItem
		if json.Unmarshal([]byte(raw), &item) == nil {
			playlist = append(playlist, item)
		}
	}
	return playlist, nil
}

func (h *Hub) popNextScreeningPlaylistItem(channelID int64) (models.ScreeningPlaylistItem, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	raw, err := h.rdb.LPop(ctx, h.screeningPlaylistKey(channelID)).Result()
	if err == redis.Nil {
		return models.ScreeningPlaylistItem{}, false, nil
	}
	if err != nil {
		return models.ScreeningPlaylistItem{}, false, err
	}
	var item models.ScreeningPlaylistItem
	if err := json.Unmarshal([]byte(raw), &item); err != nil {
		return models.ScreeningPlaylistItem{}, false, err
	}
	return item, true, nil
}

func (h *Hub) loadScreeningSnapshot(channelID int64) (models.ScreeningSnapshot, error) {
	state, err := h.loadOrInitScreeningState(channelID, 0)
	if err != nil {
		return models.ScreeningSnapshot{}, err
	}
	viewers, err := h.loadScreeningViewers(channelID)
	if err != nil {
		return models.ScreeningSnapshot{}, err
	}
	playlist, err := h.loadScreeningPlaylist(channelID)
	if err != nil {
		return models.ScreeningSnapshot{}, err
	}
	return models.ScreeningSnapshot{
		State:    state,
		Viewers:  viewers,
		Playlist: playlist,
	}, nil
}

func (h *Hub) broadcastScreeningSnapshot(channelID int64) error {
	snapshot, err := h.loadScreeningSnapshot(channelID)
	if err != nil {
		return err
	}
	log.Printf("[screening-backend] snapshot channel=%d item=%s url=%s controller=%d viewers=%d playlist=%d", channelID, snapshot.State.CurrentItemID, snapshot.State.CurrentURL, snapshot.State.ControllerUserID, len(snapshot.Viewers), len(snapshot.Playlist))
	h.broadcastToScreening(channelID, "screening.snapshot", snapshot, nil)
	return nil
}

func (h *Hub) broadcastToScreening(channelID int64, eventType string, payload any, except *Client) {
	data, err := json.Marshal(Envelope{Type: eventType, Payload: payload})
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for client := range h.screeningClients[channelID] {
		if client == except {
			continue
		}
		select {
		case client.send <- data:
		default:
			log.Printf("dropping websocket broadcast in screening %d", channelID)
		}
	}
}

func (h *Hub) clearScreeningRoom(channelID int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = h.rdb.Del(ctx, h.screeningStateKey(channelID), h.screeningViewersKey(channelID), h.screeningPlaylistKey(channelID)).Err()
}

func (h *Hub) ensureScreeningController(client *Client, state models.ScreeningState) error {
	if state.ControllerUserID == 0 || state.ControllerUserID == client.user.ID {
		return nil
	}
	return fmt.Errorf("only the current controller can change playback")
}

func (h *Hub) broadcastTransientSystem(client *Client, channelID int64, body string) {
	msg := models.Message{
		DomainID:        client.domainID,
		ChannelID:       channelID,
		UserDisplayName: "System",
		UserAvatarColor: "#8892b0",
		MessageType:     "system",
		Body:            body,
		CreatedAt:       time.Now().UTC(),
	}
	h.broadcastToChannel(channelID, "chat.message", msg, nil)
}

func (h *Hub) forwardToUser(userID int64, eventType string, payload any) {
	data, err := json.Marshal(Envelope{Type: eventType, Payload: payload})
	if err != nil {
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.userClients[userID] {
		select {
		case client.send <- data:
		default:
			log.Printf("dropping websocket message to user %d", userID)
		}
	}
}

func (h *Hub) broadcastToChannel(channelID int64, eventType string, payload any, except *Client) {
	data, err := json.Marshal(Envelope{Type: eventType, Payload: payload})
	if err != nil {
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.channelClients[channelID] {
		if client == except {
			continue
		}
		select {
		case client.send <- data:
		default:
			log.Printf("dropping websocket broadcast in channel %d", channelID)
		}
	}
}

func (h *Hub) broadcastToDomain(domainID int64, eventType string, payload any, except *Client) {
	data, err := json.Marshal(Envelope{Type: eventType, Payload: payload})
	if err != nil {
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.clients {
		if client.domainID != domainID || client == except {
			continue
		}
		select {
		case client.send <- data:
		default:
			log.Printf("dropping websocket broadcast in domain %d", domainID)
		}
	}
}

func (h *Hub) presenceKey(channelID int64) string {
	return fmt.Sprintf("channel:presence:%d", channelID)
}

func (h *Hub) domainOnlineKey() string {
	return "online:users"
}

func (h *Hub) persistDomainUser(state *OnlineUserPresence) {
	if state == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	payload, _ := json.Marshal(state)
	if err := h.rdb.HSet(ctx, h.domainOnlineKey(), strconv.FormatInt(state.User.ID, 10), string(payload)).Err(); err != nil {
		log.Printf("redis hset domain online error: %v", err)
	}
}

func (h *Hub) removeDomainUser(userID int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if err := h.rdb.HDel(ctx, h.domainOnlineKey(), strconv.FormatInt(userID, 10)).Err(); err != nil {
		log.Printf("redis hdel domain online error: %v", err)
	}
}

func (h *Hub) refreshDomainUserLocked(userID int64) *OnlineUserPresence {
	var (
		found       bool
		currentDomain int64
		current     int64
		currentUser models.User
	)

	for client := range h.clients {
		if client.user.ID != userID {
			continue
		}
		if !found {
			found = true
			currentUser = client.user
			currentDomain = client.domainID
		}
		if client.currentChannelID != 0 {
			currentDomain = client.domainID
			current = client.currentChannelID
		}
	}

	if !found {
		delete(h.domainUsers, userID)
		return nil
	}

	state := &OnlineUserPresence{
		User:             currentUser,
		DomainID:         currentDomain,
		CurrentChannelID: current,
	}
	h.domainUsers[userID] = state
	return state
}

func (h *Hub) snapshotOnlineUser(client *Client) *OnlineUserPresence {
	return &OnlineUserPresence{
		User:             client.user,
		DomainID:         client.domainID,
		CurrentChannelID: client.currentChannelID,
	}
}

func (c *Client) readPump() {
	defer func() {
		c.hub.unregister(c)
		_ = c.conn.Close()
	}()

	c.conn.SetReadLimit(1 << 20)
	_ = c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	})

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			break
		}
		c.hub.Handle(c, message)
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(25 * time.Second)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) sendJSON(eventType string, payload any) {
	data, err := json.Marshal(Envelope{Type: eventType, Payload: payload})
	if err != nil {
		return
	}
	select {
	case c.send <- data:
	default:
	}
}

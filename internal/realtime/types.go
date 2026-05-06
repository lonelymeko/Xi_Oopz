package realtime

import "oopz/internal/models"

type Envelope struct {
	Type    string `json:"type"`
	Payload any    `json:"payload,omitempty"`
}

type IncomingEnvelope struct {
	Type    string          `json:"type"`
	Payload jsonRawEnvelope `json:"payload"`
}

type jsonRawEnvelope []byte

type PresenceMember struct {
	User          models.User `json:"user"`
	ChannelID     int64       `json:"channelId"`
	MicEnabled    bool        `json:"micEnabled"`
	ScreenSharing bool        `json:"screenSharing"`
}

type OnlineUserPresence struct {
	User             models.User `json:"user"`
	DomainID         int64       `json:"domainId"`
	CurrentChannelID int64       `json:"currentChannelId"`
}

type DomainPresenceSnapshot struct {
	OnlineUsers      []OnlineUserPresence         `json:"onlineUsers"`
	VoiceMembers     map[string][]PresenceMember  `json:"voiceMembers"`
	ScreeningMembers map[string][]models.ScreeningViewer `json:"screeningMembers"`
	OnlineCounts     map[string]int64             `json:"onlineCounts"`
}

type ChannelJoinPayload struct {
	ChannelID int64 `json:"channelId"`
}

type ChannelLeavePayload struct {
	ChannelID int64 `json:"channelId"`
}

type ChatSendPayload struct {
	ChannelID int64  `json:"channelId"`
	Body      string `json:"body"`
}

type VoiceStatePayload struct {
	ChannelID  int64 `json:"channelId"`
	MicEnabled bool  `json:"micEnabled"`
}

type ScreenStatePayload struct {
	ChannelID     int64 `json:"channelId"`
	ScreenSharing bool  `json:"screenSharing"`
}

type RTCSignalPayload struct {
	ChannelID    int64  `json:"channelId"`
	TargetUserID int64  `json:"targetUserId"`
	SourceUserID int64  `json:"sourceUserId"`
	SDP          string `json:"sdp,omitempty"`
	Candidate    string `json:"candidate,omitempty"`
	Kind         string `json:"kind,omitempty"`
	Reason       string `json:"reason,omitempty"`
	RelayOnly    bool   `json:"relayOnly,omitempty"`
}

type ScreeningJoinPayload struct {
	ChannelID int64 `json:"channelId"`
}

type ScreeningLeavePayload struct {
	ChannelID int64 `json:"channelId"`
}

type ScreeningReplacePayload struct {
	ChannelID int64  `json:"channelId"`
	URL       string `json:"url"`
	Title     string `json:"title"`
}

type ScreeningAddPayload struct {
	ChannelID int64  `json:"channelId"`
	URL       string `json:"url"`
	Title     string `json:"title"`
}

type ScreeningPlaybackPayload struct {
	ChannelID    int64   `json:"channelId"`
	ItemID       string  `json:"itemId"`
	CurrentTime  float64 `json:"currentTime"`
	PlaybackRate float64 `json:"playbackRate"`
}

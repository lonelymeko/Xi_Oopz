package app

import (
	"os"

	"github.com/gin-gonic/gin"

	"oopz/internal/httpapi"
	"oopz/internal/realtime"
)

// RegisterRoutes 注册 HTTP 与 WebSocket 路由。
func RegisterRoutes(router *gin.Engine, application *App, hub *realtime.Hub) {
	handler := httpapi.NewHandler(
		application.Store,
		hub,
		application.Auth,
		application.Redis,
		application.Mailer,
		application.Config.WebRTCIceServers(),
	)

	router.GET("/healthz", handler.Healthz)
	router.GET("/api/domains", handler.ListDomains)
	router.POST("/api/domains", handler.CreateDomain)
	router.POST("/api/auth/send-verification-code", handler.SendVerificationCode)
	router.POST("/api/auth/register", handler.Register)
	router.POST("/api/auth/login", handler.Login)
	router.GET("/api/auth/me", handler.Me)
	router.POST("/api/users/guest", handler.CreateGuestUser)
	router.GET("/api/bootstrap", handler.Bootstrap)
	router.GET("/api/domains/:domainId", handler.GetDomain)
	router.PATCH("/api/domains/:domainId", handler.UpdateDomain)
	router.GET("/api/domains/:domainId/members", handler.DomainMembers)
	router.GET("/api/domains/:domainId/channels", handler.DomainChannels)
	router.GET("/api/domains/:domainId/presence", handler.DomainPresence)
	router.POST("/api/domains/:domainId/categories", handler.CreateCategory)
	router.POST("/api/domains/:domainId/channels", handler.CreateChannel)
	router.GET("/api/domains/:domainId/channels/:channelId/messages", handler.ChannelMessages)
	router.PATCH("/api/channels/:channelId", handler.UpdateChannel)
	// 把 HLS 清单拼成单个文件流，交给浏览器原生下载（fMP4 源走这条）
	router.GET("/api/media/download.m3u8", handler.DownloadHLS)
	router.OPTIONS("/api/media/download.m3u8", handler.DownloadHLS)
	router.GET("/api/media/proxy.m3u8", handler.ProxyMedia)
	router.OPTIONS("/api/media/proxy.m3u8", handler.ProxyMedia)
	router.GET("/api/media/proxy", handler.ProxyMedia)
	router.GET("/api/media/resolve", handler.ResolveMedia)
	router.OPTIONS("/api/media/resolve", handler.ResolveMedia)
	router.OPTIONS("/api/media/proxy", handler.ProxyMedia)
	router.GET("/ws", handler.ServeWS)
}

func RegisterStatic(router *gin.Engine) {
	if _, err := os.Stat("./frontend/dist"); err == nil {
		router.Static("/assets", "./frontend/dist/assets")
		router.GET("/", func(c *gin.Context) {
			c.File("./frontend/dist/index.html")
		})
		return
	}

	router.GET("/", func(c *gin.Context) {
		c.String(503, "frontend dist not found, please run frontend build first")
	})
}

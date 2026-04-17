package main

import (
	"errors"
	"log"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"

	"oopz/internal/app"
	"oopz/internal/config"
	"oopz/internal/realtime"
)

func main() {

	cfg := config.Load()

	application, err := app.New(cfg)
	if err != nil {
		log.Fatalf("init app: %v", err)
	}
	defer application.Close()

	hub := realtime.NewHub(application.Store, application.Redis, application.Auth)

	router := gin.Default()
	app.RegisterRoutes(router, application, hub)
	app.RegisterStatic(router)

	server := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: router,
	}

	log.Printf("oopz listening on http://localhost:%s", cfg.Port)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Printf("server stopped: %v", err)
		os.Exit(1)
	}
}

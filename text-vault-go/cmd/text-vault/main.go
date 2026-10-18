package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/xfn/text-vault/internal/auth"
	"github.com/xfn/text-vault/internal/httpapi"
	"github.com/xfn/text-vault/internal/store"
	"github.com/xfn/text-vault/web"
)

func main() {
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "backup" {
		if err := runBackup(args[1:]); err != nil {
			slog.Error("backup failed", "error", err)
			os.Exit(1)
		}
		return
	}
	if len(args) > 0 && args[0] == "serve" {
		args = args[1:]
	}
	cfg, err := parseConfig(args)
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(2)
	}
	database, err := store.Open(cfg.database)
	if err != nil {
		slog.Error("database failed", "error", err)
		os.Exit(1)
	}
	defer database.Close()
	authHash, err := database.AuthHash(context.Background())
	if errors.Is(err, store.ErrNotFound) {
		authHash = nil
	} else if err != nil {
		slog.Error("authentication metadata failed", "error", err)
		os.Exit(1)
	}
	sessions, err := auth.New(authHash, cfg.secureCookie)
	if err != nil {
		slog.Error("authentication failed", "error", err)
		os.Exit(2)
	}

	server := &http.Server{
		Addr: cfg.listen,
		Handler: httpapi.New(httpapi.Config{
			Frontend: web.FS,
			Store:    database,
			Auth:     sessions,
		}),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	slog.Info("text-vault listening", "address", server.Addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("server failed", "error", err)
		os.Exit(1)
	}
}

type backupConfig struct {
	database string
	output   string
}

func parseBackupConfig(args []string) (backupConfig, error) {
	flags := flag.NewFlagSet("text-vault backup", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var cfg backupConfig
	flags.StringVar(&cfg.database, "database", "./data/text-vault.db", "source SQLite database path")
	flags.StringVar(&cfg.output, "output", "", "new backup database path")
	if err := flags.Parse(args); err != nil {
		return backupConfig{}, err
	}
	if flags.NArg() != 0 {
		return backupConfig{}, fmt.Errorf("unexpected arguments: %v", flags.Args())
	}
	if cfg.output == "" {
		return backupConfig{}, errors.New("-output is required")
	}
	return cfg, nil
}

func runBackup(args []string) error {
	cfg, err := parseBackupConfig(args)
	if err != nil {
		return err
	}
	database, err := store.Open(cfg.database)
	if err != nil {
		return err
	}
	defer database.Close()
	if err := database.Backup(context.Background(), cfg.output); err != nil {
		return err
	}
	slog.Info("backup complete", "output", cfg.output)
	return nil
}

type config struct {
	listen       string
	database     string
	secureCookie bool
}

func parseConfig(args []string) (config, error) {
	flags := flag.NewFlagSet("text-vault", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var cfg config
	flags.StringVar(&cfg.listen, "listen", "127.0.0.1:8080", "HTTP listen address")
	flags.StringVar(&cfg.database, "database", "./data/text-vault.db", "SQLite database path")
	flags.BoolVar(&cfg.secureCookie, "secure-cookie", true, "require HTTPS session cookies")
	if err := flags.Parse(args); err != nil {
		return config{}, err
	}
	if flags.NArg() != 0 {
		return config{}, fmt.Errorf("unexpected arguments: %v", flags.Args())
	}
	return cfg, nil
}

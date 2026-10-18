package httpapi

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io/fs"
	"net/http"
	"path"
	"strconv"
	"strings"

	"github.com/xfn/text-vault/internal/auth"
	"github.com/xfn/text-vault/internal/store"
)

type Config struct {
	Frontend fs.FS
	Store    *store.Store
	Auth     *auth.Manager
}

func New(cfg Config) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})
	if cfg.Store != nil && cfg.Auth != nil {
		mux.HandleFunc("GET /api/vault", func(w http.ResponseWriter, r *http.Request) {
			header, err := cfg.Store.VaultHeader(r.Context())
			if err != nil {
				if err == store.ErrNotFound {
					writeAPIError(w, http.StatusNotFound, "vault_not_found")
					return
				}
				writeAPIError(w, http.StatusInternalServerError, "store_failed")
				return
			}
			writeJSON(w, http.StatusOK, header)
		})
		mux.HandleFunc("POST /api/setup", func(w http.ResponseWriter, r *http.Request) {
			if !isJSON(r) {
				writeAPIError(w, http.StatusUnsupportedMediaType, "json_required")
				return
			}
			decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 72<<10))
			decoder.DisallowUnknownFields()
			var input struct {
				Header     json.RawMessage `json:"header"`
				Credential string          `json:"credential"`
			}
			if err := decoder.Decode(&input); err != nil || !validCredential(input.Credential) {
				writeAPIError(w, http.StatusBadRequest, "invalid_setup")
				return
			}
			hash := sha256.Sum256([]byte(input.Credential))
			if err := cfg.Store.CreateVault(r.Context(), input.Header, hash[:]); err != nil {
				if err == store.ErrConflict {
					writeAPIError(w, http.StatusConflict, "conflict")
					return
				}
				writeAPIError(w, http.StatusBadRequest, "invalid_setup")
				return
			}
			if err := cfg.Auth.SetAuthHash(hash[:]); err != nil {
				writeAPIError(w, http.StatusInternalServerError, "auth_failed")
				return
			}
			cfg.Auth.LoginCredential(w, input.Credential)
		})
		mux.HandleFunc("POST /api/login", func(w http.ResponseWriter, r *http.Request) {
			if !isJSON(r) {
				writeAPIError(w, http.StatusUnsupportedMediaType, "json_required")
				return
			}
			cfg.Auth.Login(w, r)
		})

		protected := http.NewServeMux()
		protected.HandleFunc("GET /api/snapshot", func(w http.ResponseWriter, r *http.Request) {
			snapshot, err := cfg.Store.Snapshot(r.Context())
			if err != nil {
				writeAPIError(w, http.StatusInternalServerError, "store_failed")
				return
			}
			writeJSON(w, http.StatusOK, snapshot)
		})
		protected.HandleFunc("GET /api/changes", func(w http.ResponseWriter, r *http.Request) {
			after, err := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
			if err != nil {
				writeAPIError(w, http.StatusBadRequest, "invalid_generation")
				return
			}
			changes, err := cfg.Store.Changes(r.Context(), after)
			if err != nil {
				writeAPIError(w, http.StatusInternalServerError, "store_failed")
				return
			}
			writeJSON(w, http.StatusOK, changes)
		})
		protected.HandleFunc("POST /api/commit", requireCSRF(cfg.Auth, func(w http.ResponseWriter, r *http.Request) {
			if !isJSON(r) {
				writeAPIError(w, http.StatusUnsupportedMediaType, "json_required")
				return
			}
			decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
			decoder.DisallowUnknownFields()
			var request store.CommitRequest
			if err := decoder.Decode(&request); err != nil {
				writeAPIError(w, http.StatusBadRequest, "invalid_commit")
				return
			}
			manifest, err := cfg.Store.Commit(r.Context(), request)
			if err != nil {
				if err == store.ErrConflict {
					writeAPIError(w, http.StatusConflict, "conflict")
					return
				}
				writeAPIError(w, http.StatusBadRequest, "invalid_commit")
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"manifest": manifest})
		}))
		protected.HandleFunc("POST /api/rekey", requireCSRF(cfg.Auth, func(w http.ResponseWriter, r *http.Request) {
			decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 72<<10))
			decoder.DisallowUnknownFields()
			var input struct {
				Header     json.RawMessage `json:"header"`
				Credential string          `json:"credential"`
			}
			if !isJSON(r) || decoder.Decode(&input) != nil || !validCredential(input.Credential) {
				writeAPIError(w, http.StatusBadRequest, "invalid_rekey")
				return
			}
			hash := sha256.Sum256([]byte(input.Credential))
			if err := cfg.Store.RotateVault(r.Context(), input.Header, hash[:]); err != nil {
				writeAPIError(w, http.StatusBadRequest, "invalid_rekey")
				return
			}
			if err := cfg.Auth.ReplaceAuthHash(hash[:]); err != nil {
				writeAPIError(w, http.StatusInternalServerError, "auth_failed")
				return
			}
			// Password rotation invalidates every old session. Issue the caller a
			// fresh cookie and CSRF token in this response, avoiding a stranded
			// browser between rekey and a separate login request.
			cfg.Auth.LoginCredential(w, input.Credential)
		}))
		protected.HandleFunc("POST /api/logout", requireCSRF(cfg.Auth, cfg.Auth.Logout))
		mux.Handle("/api/", cfg.Auth.Require(protected))
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "." || name == "" {
			name = "index.html"
		}
		if _, err := fs.Stat(cfg.Frontend, name); err != nil {
			name = "index.html"
		}
		if name == "index.html" {
			r.URL.Path = "/"
		} else {
			r.URL.Path = "/" + name
		}
		http.FileServerFS(cfg.Frontend).ServeHTTP(w, r)
	})
	// API state changes independently of static assets. Disabling HTTP caches here
	// prevents a browser from reusing the initial vault_not_found response after setup.
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		} else {
			// Assets are not fingerprinted in this no-build application, so force
			// revalidation after a binary upgrade instead of serving stale JS.
			w.Header().Set("Cache-Control", "no-cache")
		}
		mux.ServeHTTP(w, r)
	})
}

func validCredential(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == 32
}

func requireCSRF(manager *auth.Manager, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !manager.ValidCSRF(r) {
			writeAPIError(w, http.StatusForbidden, "csrf_failed")
			return
		}
		next(w, r)
	}
}

func isJSON(r *http.Request) bool {
	return strings.EqualFold(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]), "application/json")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeAPIError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

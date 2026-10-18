package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"
)

const cookieName = "text_vault_session"

type session struct {
	csrf      string
	expiresAt time.Time
}

type Manager struct {
	tokenHash    [32]byte
	configured   bool
	secureCookie bool
	mu           sync.RWMutex
	sessions     map[[32]byte]session
	failedLogins int
	blockedUntil time.Time
	now          func() time.Time
}

func New(authHash []byte, secureCookie bool) (*Manager, error) {
	if len(authHash) != 0 && len(authHash) != sha256.Size {
		return nil, errors.New("authentication hash must contain 32 bytes")
	}
	manager := &Manager{
		secureCookie: secureCookie,
		sessions:     make(map[[32]byte]session),
		now:          time.Now,
	}
	if len(authHash) != 0 {
		copy(manager.tokenHash[:], authHash)
		manager.configured = true
	}
	return manager, nil
}

func (m *Manager) SetAuthHash(authHash []byte) error {
	if len(authHash) != sha256.Size {
		return errors.New("authentication hash must contain 32 bytes")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.configured {
		return errors.New("authentication is already configured")
	}
	copy(m.tokenHash[:], authHash)
	m.configured = true
	m.failedLogins = 0
	m.blockedUntil = time.Time{}
	return nil
}

func (m *Manager) ReplaceAuthHash(authHash []byte) error {
	if len(authHash) != sha256.Size {
		return errors.New("authentication hash must contain 32 bytes")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	copy(m.tokenHash[:], authHash)
	m.configured = true
	m.failedLogins = 0
	m.blockedUntil = time.Time{}
	// A password change is also a session rotation. Existing browser sessions
	// cannot continue writing with credentials derived from the old password.
	clear(m.sessions)
	return nil
}

func (m *Manager) Login(w http.ResponseWriter, r *http.Request) bool {
	defer r.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(r.Body, 8<<10))
	decoder.DisallowUnknownFields()
	var input struct {
		Credential string `json:"credential"`
	}
	if decoder.Decode(&input) != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return false
	}
	return m.LoginCredential(w, input.Credential)
}

func (m *Manager) LoginCredential(w http.ResponseWriter, credential string) bool {
	now := m.now()
	m.mu.RLock()
	blockedUntil := m.blockedUntil
	m.mu.RUnlock()
	if now.Before(blockedUntil) {
		retry := int(blockedUntil.Sub(now).Seconds()) + 1
		w.Header().Set("Retry-After", strconv.Itoa(retry))
		writeError(w, http.StatusTooManyRequests, "try_later")
		return false
	}
	candidate := sha256.Sum256([]byte(credential))
	m.mu.RLock()
	configured := m.configured
	expected := m.tokenHash
	m.mu.RUnlock()
	if !configured || subtle.ConstantTimeCompare(candidate[:], expected[:]) != 1 {
		m.mu.Lock()
		m.failedLogins++
		exponent := min(m.failedLogins-1, 5)
		m.blockedUntil = now.Add(time.Second * time.Duration(1<<exponent))
		m.mu.Unlock()
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return false
	}
	m.mu.Lock()
	m.failedLogins = 0
	m.blockedUntil = time.Time{}
	m.mu.Unlock()
	sessionID, err := randomToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "random_failed")
		return false
	}
	csrf, err := randomToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "random_failed")
		return false
	}
	expires := time.Now().Add(24 * time.Hour)
	m.mu.Lock()
	m.sessions[sha256.Sum256([]byte(sessionID))] = session{csrf: csrf, expiresAt: expires}
	m.mu.Unlock()
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: sessionID, Path: "/", HttpOnly: true,
		Secure: m.secureCookie, SameSite: http.SameSiteStrictMode, Expires: expires,
	})
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-CSRF-Token", csrf)
	_ = json.NewEncoder(w).Encode(map[string]string{"csrfToken": csrf})
	return true
}

func (m *Manager) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := m.lookup(r); !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (m *Manager) ValidCSRF(r *http.Request) bool {
	current, ok := m.lookup(r)
	if !ok {
		return false
	}
	want := []byte(current.csrf)
	got := []byte(r.Header.Get("X-CSRF-Token"))
	return len(want) == len(got) && subtle.ConstantTimeCompare(want, got) == 1
}

func (m *Manager) Logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(cookieName); err == nil {
		m.mu.Lock()
		delete(m.sessions, sha256.Sum256([]byte(cookie.Value)))
		m.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: "", Path: "/", HttpOnly: true,
		Secure: m.secureCookie, SameSite: http.SameSiteStrictMode, MaxAge: -1,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (m *Manager) lookup(r *http.Request) (session, bool) {
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		return session{}, false
	}
	key := sha256.Sum256([]byte(cookie.Value))
	m.mu.RLock()
	current, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok || time.Now().After(current.expiresAt) {
		if ok {
			m.mu.Lock()
			delete(m.sessions, key)
			m.mu.Unlock()
		}
		return session{}, false
	}
	return current, true
}

func randomToken() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func writeError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}

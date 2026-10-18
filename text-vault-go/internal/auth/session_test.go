package auth

import (
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLoginCreatesSessionWithCSRFProtection(t *testing.T) {
	credential := "derived-browser-credential"
	hash := sha256.Sum256([]byte(credential))
	manager, err := New(hash[:], false)
	if err != nil {
		t.Fatal(err)
	}
	login := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{"credential":"derived-browser-credential"}`))
	if !manager.Login(login, request) {
		t.Fatalf("login rejected: %d %s", login.Code, login.Body.String())
	}
	if login.Code != http.StatusOK || len(login.Result().Cookies()) != 1 {
		t.Fatalf("login response = %d cookies=%d", login.Code, len(login.Result().Cookies()))
	}
	csrf := login.Header().Get("X-CSRF-Token")
	if csrf == "" {
		t.Fatal("missing CSRF token")
	}

	called := false
	protected := manager.Require(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	authorized := httptest.NewRequest(http.MethodGet, "/api/snapshot", nil)
	authorized.AddCookie(login.Result().Cookies()[0])
	protected.ServeHTTP(httptest.NewRecorder(), authorized)
	if !called {
		t.Fatal("valid session was rejected")
	}

	write := httptest.NewRequest(http.MethodPost, "/api/commit", nil)
	write.AddCookie(login.Result().Cookies()[0])
	write.Header.Set("X-CSRF-Token", csrf)
	if !manager.ValidCSRF(write) {
		t.Fatal("valid CSRF token was rejected")
	}
}

func TestLoginRejectsWrongToken(t *testing.T) {
	hash := sha256.Sum256([]byte("derived-browser-credential"))
	manager, err := New(hash[:], false)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{"credential":"wrong"}`))
	if manager.Login(response, request) || response.Code != http.StatusUnauthorized {
		t.Fatalf("wrong login = %d %s", response.Code, response.Body.String())
	}
}

func TestUnconfiguredManagerRejectsLoginUntilCredentialIsInstalled(t *testing.T) {
	manager, err := New(nil, false)
	if err != nil {
		t.Fatal(err)
	}
	request := func() *http.Request {
		return httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{"credential":"derived-browser-credential"}`))
	}
	if manager.Login(httptest.NewRecorder(), request()) {
		t.Fatal("unconfigured authentication accepted a login")
	}
	hash := sha256.Sum256([]byte("derived-browser-credential"))
	if err := manager.SetAuthHash(hash[:]); err != nil {
		t.Fatal(err)
	}
	if !manager.Login(httptest.NewRecorder(), request()) {
		t.Fatal("installed authentication hash rejected login")
	}
}

func TestReplaceAuthHashInvalidatesOldCredentialAndSessions(t *testing.T) {
	oldCredential := strings.Repeat("A", 43)
	newCredential := strings.Repeat("B", 43)
	oldHash := sha256.Sum256([]byte(oldCredential))
	manager, err := New(oldHash[:], false)
	if err != nil {
		t.Fatal(err)
	}
	login := httptest.NewRecorder()
	if !manager.LoginCredential(login, oldCredential) {
		t.Fatal("old credential did not initially work")
	}
	newHash := sha256.Sum256([]byte(newCredential))
	if err := manager.ReplaceAuthHash(newHash[:]); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC)
	manager.now = func() time.Time { return now }
	oldSession := httptest.NewRequest(http.MethodGet, "/api/snapshot", nil)
	oldSession.AddCookie(login.Result().Cookies()[0])
	called := false
	manager.Require(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true })).ServeHTTP(httptest.NewRecorder(), oldSession)
	if called || manager.LoginCredential(httptest.NewRecorder(), oldCredential) {
		t.Fatal("old authentication survived rotation")
	}
	now = now.Add(time.Second)
	if !manager.LoginCredential(httptest.NewRecorder(), newCredential) {
		t.Fatal("new credential was rejected")
	}
}

func TestFailedLoginTemporarilyThrottlesAttemptsAndSuccessResetsIt(t *testing.T) {
	credential := strings.Repeat("A", 43)
	hash := sha256.Sum256([]byte(credential))
	manager, err := New(hash[:], false)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC)
	manager.now = func() time.Time { return now }

	wrong := httptest.NewRecorder()
	manager.LoginCredential(wrong, strings.Repeat("B", 43))
	if wrong.Code != http.StatusUnauthorized {
		t.Fatalf("first failure = %d", wrong.Code)
	}
	throttled := httptest.NewRecorder()
	manager.LoginCredential(throttled, credential)
	if throttled.Code != http.StatusTooManyRequests || throttled.Header().Get("Retry-After") == "" {
		t.Fatalf("throttled = %d retry=%q", throttled.Code, throttled.Header().Get("Retry-After"))
	}

	now = now.Add(time.Second)
	if !manager.LoginCredential(httptest.NewRecorder(), credential) {
		t.Fatal("correct credential was rejected after delay")
	}
	afterSuccess := httptest.NewRecorder()
	manager.LoginCredential(afterSuccess, strings.Repeat("B", 43))
	if afterSuccess.Code != http.StatusUnauthorized {
		t.Fatalf("failure state was not reset: %d", afterSuccess.Code)
	}
}

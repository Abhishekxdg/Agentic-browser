package soundbrowser

import (
	"net/http"
	"testing"
	"time"
)

func TestNewDefaults(t *testing.T) {
	t.Setenv("SOUND_BROWSER_URL", "")
	t.Setenv("AGENT_BROWSER_URL", "")
	t.Setenv("SOUND_BROWSER_API_KEY", "")
	t.Setenv("AGENT_BROWSER_API_KEY", "")

	c := New()
	if c.BaseURL != "http://localhost:3001" {
		t.Fatalf("BaseURL = %q", c.BaseURL)
	}
	if c.APIKey != "dev-key" {
		t.Fatalf("APIKey = %q", c.APIKey)
	}
	if c.HTTPClient.Timeout != 120*time.Second {
		t.Fatalf("timeout = %s", c.HTTPClient.Timeout)
	}
}

func TestOptions(t *testing.T) {
	httpClient := &http.Client{Timeout: time.Second}
	c := New(
		WithBaseURL("http://localhost:9999/"),
		WithAPIKey("secret"),
		WithHTTPClient(httpClient),
	)
	if c.BaseURL != "http://localhost:9999" {
		t.Fatalf("BaseURL = %q", c.BaseURL)
	}
	if c.APIKey != "secret" {
		t.Fatalf("APIKey = %q", c.APIKey)
	}
	if c.HTTPClient != httpClient {
		t.Fatal("HTTPClient option not applied")
	}
}

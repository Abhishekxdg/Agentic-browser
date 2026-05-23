package soundbrowser

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type Client struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
}

type Option func(*Client)

func WithBaseURL(baseURL string) Option {
	return func(c *Client) { c.BaseURL = strings.TrimRight(baseURL, "/") }
}

func WithAPIKey(apiKey string) Option {
	return func(c *Client) { c.APIKey = apiKey }
}

func WithHTTPClient(httpClient *http.Client) Option {
	return func(c *Client) { c.HTTPClient = httpClient }
}

func New(opts ...Option) *Client {
	c := &Client{
		BaseURL: getenv("SOUND_BROWSER_URL", getenv("AGENT_BROWSER_URL", "http://localhost:3001")),
		APIKey:  getenv("SOUND_BROWSER_API_KEY", getenv("AGENT_BROWSER_API_KEY", "dev-key")),
		HTTPClient: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
	c.BaseURL = strings.TrimRight(c.BaseURL, "/")
	for _, opt := range opts {
		opt(c)
	}
	return c
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

type SessionOptions struct {
	Headless *bool  `json:"headless,omitempty"`
	Proxy    string `json:"proxy,omitempty"`
}

type SemanticPage struct {
	Page        PageInfo        `json:"page"`
	Forms       []SemanticForm  `json:"forms"`
	Navigation  []SemanticLink  `json:"navigation"`
	Content     []ContentBlock  `json:"content"`
	Interactive []Interactive   `json:"interactive"`
	Tables      []SemanticTable `json:"tables"`
	Dialogs     []Dialog       `json:"dialogs"`
	Search      *SearchInfo    `json:"search"`
}

type PageInfo struct {
	URL      string   `json:"url"`
	Title    string   `json:"title"`
	Viewport Viewport `json:"viewport"`
}

type Viewport struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

type SemanticForm struct {
	ID      string           `json:"id"`
	Purpose string           `json:"purpose,omitempty"`
	Action  string           `json:"action,omitempty"`
	Method  string           `json:"method,omitempty"`
	Fields  []SemanticField  `json:"fields"`
	Actions []SemanticButton `json:"actions"`
}

type SemanticField struct {
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	Label       string   `json:"label,omitempty"`
	Placeholder string   `json:"placeholder,omitempty"`
	Required    bool     `json:"required,omitempty"`
	Value       any      `json:"value,omitempty"`
	Options     []string `json:"options,omitempty"`
}

type SemanticButton struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	Label  string `json:"label"`
	Action string `json:"action,omitempty"`
}

type SemanticLink struct {
	Text     string `json:"text"`
	Href     string `json:"href"`
	Type     string `json:"type"`
	External bool   `json:"external,omitempty"`
}

type ContentBlock struct {
	Type  string `json:"type"`
	Level int    `json:"level,omitempty"`
	Text  string `json:"text"`
}

type Interactive struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Label string `json:"label"`
	State string `json:"state,omitempty"`
}

type SemanticTable struct {
	ID      string     `json:"id"`
	Caption string     `json:"caption,omitempty"`
	Headers []string   `json:"headers"`
	Rows    [][]string `json:"rows"`
}

type Dialog struct {
	Type    string   `json:"type"`
	Title   string   `json:"title,omitempty"`
	Message string   `json:"message,omitempty"`
	Actions []string `json:"actions"`
}

type SearchInfo struct {
	FieldName   string `json:"fieldName"`
	Placeholder string `json:"placeholder,omitempty"`
	HasSubmit   bool   `json:"hasSubmit"`
}

type Action map[string]any

type ActionResult struct {
	Success      bool    `json:"success"`
	Data         any     `json:"data,omitempty"`
	Error        string  `json:"error,omitempty"`
	Confidence   float64 `json:"confidence,omitempty"`
	Strategy     string  `json:"strategy,omitempty"`
	Verification any     `json:"verification,omitempty"`
	Page         any     `json:"page,omitempty"`
}

type AgentRunResult struct {
	Success     bool           `json:"success"`
	Goal        string         `json:"goal"`
	Steps       []map[string]any `json:"steps"`
	FinalAnswer string         `json:"final_answer,omitempty"`
	TotalSteps  int            `json:"total_steps"`
	Error       string         `json:"error,omitempty"`
}

type Job struct {
	ID         string         `json:"id"`
	Type       string         `json:"type"`
	Status     string         `json:"status"`
	CreatedAt  string         `json:"created_at"`
	StartedAt  string         `json:"started_at,omitempty"`
	FinishedAt string         `json:"finished_at,omitempty"`
	Goal       string         `json:"goal,omitempty"`
	Result     map[string]any `json:"result,omitempty"`
	Error      string         `json:"error,omitempty"`
}

type ReplayResult struct {
	SessionID            string       `json:"session_id"`
	SourceTraceSessionID string       `json:"source_trace_session_id,omitempty"`
	Success             bool         `json:"success"`
	TotalSteps          int          `json:"total_steps"`
	PassedSteps         int          `json:"passed_steps"`
	FailedSteps         int          `json:"failed_steps"`
	DurationMS          int          `json:"duration_ms"`
	Steps               []ReplayStep `json:"steps"`
}

type ReplayStep struct {
	Index     int    `json:"index"`
	Action    Action `json:"action"`
	Success   bool   `json:"success"`
	Error     string `json:"error,omitempty"`
	ElapsedMS int    `json:"elapsed_ms"`
}

type EvalCase struct {
	Name    string      `json:"name"`
	Site    string      `json:"site,omitempty"`
	Actions []Action    `json:"actions"`
	Checks  []EvalCheck `json:"checks,omitempty"`
}

type EvalCheck struct {
	Name       string `json:"name"`
	Expression string `json:"expression"`
	Expected   any    `json:"expected,omitempty"`
}

type EvalRunResult struct {
	Success bool             `json:"success"`
	Cases   []map[string]any `json:"cases"`
	Summary EvalSummary      `json:"summary"`
}

type EvalSummary struct {
	TotalCases        int     `json:"total_cases"`
	PassedCases       int     `json:"passed_cases"`
	ReliabilityScore  float64 `json:"reliability_score"`
	ActionSuccessRate float64 `json:"action_success_rate"`
	AvgLatencyMS      float64 `json:"avg_latency_ms"`
	HallucinationRate float64 `json:"hallucination_rate"`
}

func (c *Client) CreateSession(ctx context.Context, opts SessionOptions) (string, error) {
	var out struct {
		SessionID string `json:"session_id"`
	}
	if err := c.post(ctx, "/session", opts, &out); err != nil {
		return "", err
	}
	return out.SessionID, nil
}

func (c *Client) CloseSession(ctx context.Context, sessionID string) error {
	return c.delete(ctx, "/session/"+url.PathEscape(sessionID), nil)
}

func (c *Client) WithSession(ctx context.Context, opts SessionOptions, fn func(string) error) error {
	sessionID, err := c.CreateSession(ctx, opts)
	if err != nil {
		return err
	}
	defer c.CloseSession(ctx, sessionID)
	return fn(sessionID)
}

func (c *Client) Navigate(ctx context.Context, sessionID, targetURL string) (*SemanticPage, error) {
	var out struct {
		Page SemanticPage `json:"page"`
	}
	err := c.post(ctx, "/session/"+url.PathEscape(sessionID)+"/navigate", map[string]any{"url": targetURL}, &out)
	return &out.Page, err
}

func (c *Client) GetPage(ctx context.Context, sessionID string, fresh bool) (*SemanticPage, error) {
	path := "/session/" + url.PathEscape(sessionID) + "/page"
	if fresh {
		path += "?fresh=true"
	}
	var out struct {
		Page SemanticPage `json:"page"`
	}
	err := c.get(ctx, path, &out)
	return &out.Page, err
}

func (c *Client) Action(ctx context.Context, sessionID string, action Action) (*ActionResult, error) {
	var out ActionResult
	err := c.post(ctx, "/session/"+url.PathEscape(sessionID)+"/action", action, &out)
	return &out, err
}

func (c *Client) Actions(ctx context.Context, sessionID string, actions []Action) ([]ActionResult, error) {
	var out struct {
		Results []ActionResult `json:"results"`
	}
	err := c.post(ctx, "/session/"+url.PathEscape(sessionID)+"/actions", map[string]any{"actions": actions}, &out)
	return out.Results, err
}

func (c *Client) Run(ctx context.Context, sessionID, goal string, opts map[string]any) (*AgentRunResult, error) {
	body := map[string]any{"goal": goal}
	for k, v := range opts {
		body[k] = v
	}
	var out AgentRunResult
	err := c.post(ctx, "/session/"+url.PathEscape(sessionID)+"/run", body, &out)
	return &out, err
}

func (c *Client) SaveStateSnapshot(ctx context.Context, sessionID, profile string) (map[string]any, error) {
	var out map[string]any
	err := c.post(ctx, "/session/"+url.PathEscape(sessionID)+"/state/save", map[string]any{"profile": profile}, &out)
	return out, err
}

func (c *Client) LoadStateSnapshot(ctx context.Context, sessionID, profile string) (map[string]any, error) {
	var out map[string]any
	err := c.post(ctx, "/session/"+url.PathEscape(sessionID)+"/state/load", map[string]any{"profile": profile}, &out)
	return out, err
}

func (c *Client) RunEval(ctx context.Context, cases []EvalCase) (*EvalRunResult, error) {
	var out EvalRunResult
	err := c.post(ctx, "/eval/run", map[string]any{"cases": cases}, &out)
	return &out, err
}

func (c *Client) ReplayActions(ctx context.Context, actions []Action, stopOnFailure bool) (*ReplayResult, error) {
	var out ReplayResult
	err := c.post(ctx, "/replay/actions", map[string]any{"actions": actions, "stop_on_failure": stopOnFailure}, &out)
	return &out, err
}

func (c *Client) ReplayTrace(ctx context.Context, traceSessionID string, stopOnFailure bool) (*ReplayResult, error) {
	var out ReplayResult
	err := c.post(ctx, "/replay/trace", map[string]any{"trace_session_id": traceSessionID, "stop_on_failure": stopOnFailure}, &out)
	return &out, err
}

func (c *Client) SubmitJob(ctx context.Context, goal string, opts map[string]any) (string, error) {
	body := map[string]any{"goal": goal}
	for k, v := range opts {
		body[k] = v
	}
	var out struct {
		JobID string `json:"job_id"`
	}
	if err := c.post(ctx, "/jobs", body, &out); err != nil {
		return "", err
	}
	return out.JobID, nil
}

func (c *Client) GetJob(ctx context.Context, jobID string) (*Job, error) {
	var out Job
	err := c.get(ctx, "/jobs/"+url.PathEscape(jobID), &out)
	return &out, err
}

func (c *Client) Health(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	err := c.get(ctx, "/health", &out)
	return out, err
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	return c.do(ctx, http.MethodGet, path, nil, out)
}

func (c *Client) post(ctx context.Context, path string, body any, out any) error {
	return c.do(ctx, http.MethodPost, path, body, out)
}

func (c *Client) delete(ctx context.Context, path string, out any) error {
	return c.do(ctx, http.MethodDelete, path, nil, out)
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(payload)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	res, err := c.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	data, err := io.ReadAll(res.Body)
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("%s %s failed %d: %s", method, path, res.StatusCode, string(data))
	}
	if out == nil || len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, out)
}

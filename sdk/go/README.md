# Sound Browser Go SDK

Dependency-free Go client for Sound Browser.

```bash
go get github.com/Abhishekxdg/Sound-Browser/sdk/go
```

```go
package main

import (
	"context"
	"fmt"

	soundbrowser "github.com/Abhishekxdg/Sound-Browser/sdk/go"
)

func main() {
	client := soundbrowser.New()
	ctx := context.Background()

	err := client.WithSession(ctx, soundbrowser.SessionOptions{}, func(sessionID string) error {
		page, err := client.Navigate(ctx, sessionID, "https://example.com")
		if err != nil {
			return err
		}
		fmt.Println(page.Page.Title)
		return nil
	})
	if err != nil {
		panic(err)
	}
}
```

Environment:

- `SOUND_BROWSER_URL`, default `http://localhost:3001`
- `SOUND_BROWSER_API_KEY`, default `dev-key`

Core methods:

- `CreateSession`, `CloseSession`, `WithSession`
- `Navigate`, `GetPage`
- `Action`, `Actions`, `Run`
- `SaveStateSnapshot`, `LoadStateSnapshot`
- `RunEval`, `ReplayActions`, `ReplayTrace`
- `SubmitJob`, `GetJob`, `Health`

// MapControl desktop wrapper: starts the Node server as a child process and
// shows it in a system WebView window. Server and frontend behaviour is
// unchanged — the frontend talks to the server over HTTP loopback as before.
//
// No JS->Go binds, no SetHtml service pages: only Navigate on loopback.
package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"

	webview "github.com/webview/webview_go"
)

const (
	basePort = 5179
	maxPort  = 5279
	host     = "localhost"
)

// techdebt: sequential scan 5179-5279 mirrors launcher.js; OS-assigned :0
// would be simpler but the URL must stay predictable for the Yandex key.
func findFreePort() (int, error) {
	for port := basePort; port <= maxPort; port++ {
		l, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, port))
		if err != nil {
			continue
		}
		_ = l.Close()
		return port, nil
	}
	return 0, fmt.Errorf("no free ports in range %d-%d", basePort, maxPort)
}

// locateServer finds src/server.js relative to the exe (desktop/../src)
// with fallbacks for `go run` (cwd-based). Returns server path + project
// root (used as child cwd so dotenv finds .env).
func locateServer() (serverPath, projectRoot string, err error) {
	var candidates []string
	if exe, e := os.Executable(); e == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(dir, "..", "src", "server.js"),
			filepath.Join(dir, "src", "server.js"),
		)
	}
	if cwd, e := os.Getwd(); e == nil {
		candidates = append(candidates,
			filepath.Join(cwd, "..", "src", "server.js"),
			filepath.Join(cwd, "src", "server.js"),
		)
	}
	for _, c := range candidates {
		if st, e := os.Stat(c); e == nil && !st.IsDir() {
			abs, e := filepath.Abs(c)
			if e != nil {
				return "", "", e
			}
			return abs, filepath.Dir(filepath.Dir(abs)), nil
		}
	}
	return "", "", fmt.Errorf("src/server.js not found next to exe or cwd")
}

func configURL(port int) string {
	return fmt.Sprintf("http://%s:%d/api/config", host, port)
}

// fetchConfig returns the /api/config payload; ok=false unless it looks
// like OUR server (same marker as launcher.js: yandexMaps field present).
func fetchConfig(port int) (data map[string]any, ok bool) {
	client := http.Client{Timeout: 2 * time.Second}
	r, err := client.Get(configURL(port))
	if err != nil {
		return nil, false
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		return nil, false
	}
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return nil, false
	}
	if _, ours := body["yandexMaps"]; !ours {
		return nil, false
	}
	return body, true
}

func waitReady(port int, timeout time.Duration) (map[string]any, bool) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if data, ok := fetchConfig(port); ok {
			return data, true
		}
		time.Sleep(500 * time.Millisecond)
	}
	return nil, false
}

// killTree kills the server process tree; context-cancel is unreliable on
// Windows, so taskkill /T /F is used explicitly (no console window).
func killTree(pid int) {
	cmd := exec.Command("taskkill", "/PID", fmt.Sprint(pid), "/T", "/F")
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}
	_ = cmd.Run()
}

// fatal shows a system error box (there is no console window to print to)
// and exits. Silent death on startup was reported as "does not launch".
func fatal(title, msg string) {
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(msg)
	procMsgBox.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), 0x10) // MB_ICONERROR
	fmt.Fprintln(os.Stderr, "[MapControl]", msg)
	os.Exit(1)
}

var (
	modUser32  = syscall.NewLazyDLL("user32.dll")
	procMsgBox = modUser32.NewProc("MessageBoxW")
)

func main() {
	port, err := findFreePort()
	if err != nil {
		fatal("MapControl", err.Error())
	}

	serverPath, projectRoot, err := locateServer()
	if err != nil {
		fatal("MapControl", "src/server.js not found. Run MapControl.exe from the desktop/ folder of the project.\n\n"+err.Error())
	}

	// CREATE_NO_WINDOW: without it Windows pops a black console window
	// next to the WebView on every child start.
	cmd := exec.Command("node", serverPath)
	cmd.Dir = projectRoot
	cmd.Env = append(os.Environ(), "PORT="+fmt.Sprint(port))
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}
	if err := cmd.Start(); err != nil {
		fatal("MapControl", "cannot start node: "+err.Error())
	}

	data, ok := waitReady(port, 30*time.Second)
	if !ok {
		killTree(cmd.Process.Pid)
		fatal("MapControl", "server did not become ready in 30s")
	}

	title := "MapControl"
	if s, _ := data["siteName"].(string); s != "" {
		title = s
	}

	w := webview.New(false)
	defer w.Destroy()
	w.SetTitle(title)
	w.SetSize(1280, 900, webview.HintNone)
	w.Navigate(fmt.Sprintf("http://%s:%d", host, port))
	w.Run()

	killTree(cmd.Process.Pid)
}

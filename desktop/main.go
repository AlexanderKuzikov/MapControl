// MapControl desktop wrapper: starts the Node server as a child process and
// shows it in a system WebView window. Server and frontend behaviour is
// unchanged — the frontend talks to the server over HTTP loopback as before.
package main

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	webview "github.com/webview/webview_go"
)

//go:embed all:bundle
var embeddedBundle embed.FS

const (
	basePort = 5179
	maxPort  = 5279
	host     = "localhost"
)

type appRuntime struct {
	nodePath   string
	serverPath string
	workingDir string
	env        map[string]string
}

func embeddedVersion() (string, error) {
	data, err := embeddedBundle.ReadFile("bundle/version.txt")
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

func copyEmbeddedFile(source, target string) error {
	input, err := embeddedBundle.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()

	output, err := os.Create(target)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func writeFileIfMissing(target string, data []byte, mode fs.FileMode) error {
	if _, err := os.Stat(target); err == nil {
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(target), ".mapcontrol-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)

	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, target); err != nil {
		if _, statErr := os.Stat(target); statErr == nil {
			return nil
		}
		return err
	}
	return nil
}

func bundleReady(target string) bool {
	complete, err := os.Stat(filepath.Join(target, ".complete"))
	if err != nil || complete.IsDir() || complete.Size() == 0 {
		return false
	}
	ready := true
	err = fs.WalkDir(embeddedBundle, "bundle", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		embeddedInfo, err := entry.Info()
		if err != nil {
			return err
		}
		relative := strings.TrimPrefix(name, "bundle/")
		extractedInfo, err := os.Stat(filepath.Join(target, filepath.FromSlash(relative)))
		if err != nil || extractedInfo.IsDir() || extractedInfo.Size() != embeddedInfo.Size() {
			ready = false
			return fs.SkipAll
		}
		return nil
	})
	return err == nil && ready
}

func acquireExtractionLock(version string) (func(), error) {
	name, err := syscall.UTF16PtrFromString(`Local\MapControlBundle-` + version)
	if err != nil {
		return nil, err
	}
	handle, _, callErr := procCreateMutex.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if handle == 0 {
		return nil, fmt.Errorf("create extraction mutex: %w", callErr)
	}

	deadline := time.Now().Add(2 * time.Minute)
	for {
		result, _, _ := procWaitForMutex.Call(handle, 0)
		if result == 0 || result == 0x80 {
			return func() {
				_, _, _ = procReleaseMutex.Call(handle)
				_, _, _ = procCloseHandle.Call(handle)
			}, nil
		}
		if result != 0x102 {
			_, _, _ = procCloseHandle.Call(handle)
			return nil, fmt.Errorf("wait for extraction mutex failed with code %d", result)
		}
		if time.Now().After(deadline) {
			_, _, _ = procCloseHandle.Call(handle)
			return nil, fmt.Errorf("timed out waiting for extraction mutex %q", version)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func extractBundle(version string) (string, error) {
	safeVersion := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.' {
			return r
		}
		return '_'
	}, version)
	if safeVersion == "" || safeVersion == "." || safeVersion == ".." {
		return "", fmt.Errorf("invalid bundle version %q", version)
	}

	cacheRoot := filepath.Join(os.TempDir(), "MapControl")
	if err := os.MkdirAll(cacheRoot, 0700); err != nil {
		return "", err
	}
	target := filepath.Join(cacheRoot, safeVersion)
	if bundleReady(target) {
		return target, nil
	}

	releaseLock, err := acquireExtractionLock(safeVersion)
	if err != nil {
		return "", err
	}
	defer releaseLock()

	if bundleReady(target) {
		return target, nil
	}
	if err := os.RemoveAll(target); err != nil {
		return "", err
	}

	staging, err := os.MkdirTemp(cacheRoot, ".extract-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(staging)

	err = fs.WalkDir(embeddedBundle, "bundle", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel("bundle", name)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		destination := filepath.Join(staging, relative)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0700)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("embedded bundle contains unsupported entry %q", name)
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
			return err
		}
		return copyEmbeddedFile(name, destination)
	})
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(staging, ".complete"), []byte(version+"\n"), 0600); err != nil {
		return "", err
	}
	if err := os.Rename(staging, target); err != nil {
		return "", err
	}
	return target, nil
}

func prepareUserDir(bundleRoot string) (string, error) {
	userDir := strings.TrimSpace(os.Getenv("MC_USER_DIR"))
	if userDir == "" {
		configRoot, err := os.UserConfigDir()
		if err != nil {
			return "", err
		}
		userDir = filepath.Join(configRoot, "MapControl")
	}
	userDir, err := filepath.Abs(userDir)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(userDir, 0700); err != nil {
		return "", err
	}

	envExample, err := os.ReadFile(filepath.Join(bundleRoot, "app", ".env.example"))
	if err != nil {
		return "", err
	}
	if err := writeFileIfMissing(filepath.Join(userDir, ".env"), envExample, 0600); err != nil {
		return "", err
	}
	operatorReadme, err := os.ReadFile(filepath.Join(bundleRoot, "ПРОЧТИ.txt"))
	if err != nil {
		return "", err
	}
	if err := writeFileIfMissing(filepath.Join(userDir, "ПРОЧТИ.txt"), operatorReadme, 0600); err != nil {
		return "", err
	}
	return userDir, nil
}

func environmentWith(overrides map[string]string) []string {
	replaced := make(map[string]bool, len(overrides))
	for key := range overrides {
		replaced[strings.ToUpper(key)] = true
	}
	environment := make([]string, 0, len(os.Environ())+len(overrides))
	for _, entry := range os.Environ() {
		key, _, ok := strings.Cut(entry, "=")
		if ok && key != "" && replaced[strings.ToUpper(key)] {
			continue
		}
		environment = append(environment, entry)
	}
	for key, value := range overrides {
		environment = append(environment, key+"="+value)
	}
	return environment
}

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

func prepareRuntime(port int) (appRuntime, error) {
	version, err := embeddedVersion()
	if err != nil {
		return appRuntime{}, fmt.Errorf("read embedded version: %w", err)
	}
	if version == "" {
		serverPath, projectRoot, err := locateServer()
		if err != nil {
			return appRuntime{}, err
		}
		return appRuntime{
			nodePath:   "node",
			serverPath: serverPath,
			workingDir: projectRoot,
			env:        map[string]string{"PORT": fmt.Sprint(port)},
		}, nil
	}

	bundleRoot, err := extractBundle(version)
	if err != nil {
		return appRuntime{}, fmt.Errorf("extract embedded bundle: %w", err)
	}
	userDir, err := prepareUserDir(bundleRoot)
	if err != nil {
		return appRuntime{}, fmt.Errorf("prepare user directory: %w", err)
	}
	return appRuntime{
		nodePath:   filepath.Join(bundleRoot, "bin", "node.exe"),
		serverPath: filepath.Join(bundleRoot, "app", "src", "server.js"),
		workingDir: filepath.Join(bundleRoot, "app"),
		env: map[string]string{
			"PORT":         fmt.Sprint(port),
			"MC_DATA_ROOT": filepath.Join(userDir, "data", "submissions"),
			"MC_ENV_FILE":  filepath.Join(userDir, ".env"),
		},
	}, nil
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
	modUser32           = syscall.NewLazyDLL("user32.dll")
	procMsgBox          = modUser32.NewProc("MessageBoxW")
	procFindWindow      = modUser32.NewProc("FindWindowW")
	procSendMessage     = modUser32.NewProc("SendMessageW")
	procLoadIcon        = modUser32.NewProc("LoadIconW")
	modKernel32         = syscall.NewLazyDLL("kernel32.dll")
	procGetModuleHandle = modKernel32.NewProc("GetModuleHandleW")
	procCreateMutex     = modKernel32.NewProc("CreateMutexW")
	procWaitForMutex    = modKernel32.NewProc("WaitForSingleObject")
	procReleaseMutex    = modKernel32.NewProc("ReleaseMutex")
	procCloseHandle     = modKernel32.NewProc("CloseHandle")
)

// setWindowIcon assigns the exe icon (rsrc resource ID 1) to the WebView
// window found by title. WebView2 does not pick the exe icon up on its own,
// so without this the title bar and taskbar show the default icon.
func setWindowIcon(title string) {
	t, _ := syscall.UTF16PtrFromString(title)
	for i := 0; i < 40; i++ {
		hwnd, _, _ := procFindWindow.Call(0, uintptr(unsafe.Pointer(t)))
		if hwnd != 0 {
			hinst, _, _ := procGetModuleHandle.Call(0)
			hicon, _, _ := procLoadIcon.Call(hinst, 1) // MAKEINTRESOURCE(1)
			if hicon != 0 {
				const wmSetIcon = 0x0080
				procSendMessage.Call(hwnd, wmSetIcon, 1, hicon) // ICON_BIG (taskbar)
				procSendMessage.Call(hwnd, wmSetIcon, 0, hicon) // ICON_SMALL (title bar)
			}
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func main() {
	port, err := findFreePort()
	if err != nil {
		fatal("MapControl", err.Error())
	}

	runtime, err := prepareRuntime(port)
	if err != nil {
		fatal("MapControl", "cannot prepare application: "+err.Error())
	}

	// CREATE_NO_WINDOW: without it Windows pops a black console window
	// next to the WebView on every child start.
	cmd := exec.Command(runtime.nodePath, runtime.serverPath)
	cmd.Dir = runtime.workingDir
	cmd.Env = environmentWith(runtime.env)
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
	if err := w.Bind("closeApp", func() {
		killTree(cmd.Process.Pid)
		w.Terminate()
	}); err != nil {
		killTree(cmd.Process.Pid)
		fatal("MapControl", "cannot bind application close: "+err.Error())
	}
	w.SetTitle(title)
	w.SetSize(1280, 900, webview.HintNone)
	w.Navigate(fmt.Sprintf("http://%s:%d", host, port))
	go setWindowIcon(title)
	w.Run()

	killTree(cmd.Process.Pid)
}

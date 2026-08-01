package httpapi

import (
	"context"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/chromedp"
	"github.com/gin-gonic/gin"
)

// 解析引擎配置：均可用环境变量覆盖，默认直连、无需代理。
var (
	mediaResolveProxy    = os.Getenv("MEDIA_RESOLVE_PROXY")   // 空 = 直连
	mediaResolveExecPath = os.Getenv("MEDIA_RESOLVE_CHROME")  // 空 = 让 chromedp 自己找 chromium
	mediaResolveTimeout  = 35 * time.Second
	mediaResolveUA       = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

// 命中即视为可播放媒体的直链特征（HLS 清单 / MP4 / 常见取流网关路径）。
var mediaHitPattern = regexp.MustCompile(`(?i)\.m3u8(\?|$)|\.mp4(\?|$)|/playurl/m3u8|/playurl/[0-9a-f]{16,}\.m3u8`)

// 明显不是正片的媒体（广告/占位片头），命中则跳过继续等待。
var mediaHitDenyPattern = regexp.MustCompile(`(?i)adposter|/ad/|/ads/|advertisement|preroll`)

// 限制并发的无头浏览器实例数量，避免解析请求打爆内存。
var mediaResolveSem = make(chan struct{}, 2)

// 同一页面 URL 的并发解析合并为一次（单飞）。
var (
	resolveGroupMu sync.Mutex
	resolveGroups  = map[string]*resolveCall{}
)

type resolveCall struct {
	done chan struct{}
	url  string
	kind string
	err  error
}

type resolveResult struct {
	MediaURL string `json:"mediaUrl"`
	Kind     string `json:"kind"` // hls / mp4
	Page     string `json:"page"`
}

// ResolveMedia 用无头浏览器打开视频页面、监听网络请求，
// 返回页面实际加载的第一个媒体直链（HLS/MP4），
// 免去用户手动开发者工具找 m3u8 的过程。
func (h *Handler) ResolveMedia(c *gin.Context) {
	setMediaProxyCORS(c)
	if c.Request.Method == http.MethodOptions {
		c.Status(http.StatusNoContent)
		return
	}

	rawTarget := strings.TrimSpace(c.Query("url"))
	target, err := validateMediaProxyTarget(c.Request.Context(), rawTarget)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	pageURL := target.String()

	mediaURL, kind, err := resolveMediaSingleFlight(c.Request.Context(), pageURL)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, resolveResult{MediaURL: mediaURL, Kind: kind, Page: pageURL})
}

// 单飞：并发请求同一页面时只跑一次无头浏览器，其余等待复用结果。
func resolveMediaSingleFlight(ctx context.Context, pageURL string) (string, string, error) {
	resolveGroupMu.Lock()
	if call, ok := resolveGroups[pageURL]; ok {
		resolveGroupMu.Unlock()
		select {
		case <-call.done:
			return call.url, call.kind, call.err
		case <-ctx.Done():
			return "", "", ctx.Err()
		}
	}
	call := &resolveCall{done: make(chan struct{})}
	resolveGroups[pageURL] = call
	resolveGroupMu.Unlock()

	call.url, call.kind, call.err = resolveMediaOnce(ctx, pageURL)
	close(call.done)

	resolveGroupMu.Lock()
	delete(resolveGroups, pageURL)
	resolveGroupMu.Unlock()
	return call.url, call.kind, call.err
}

func resolveMediaOnce(ctx context.Context, pageURL string) (string, string, error) {
	select {
	case mediaResolveSem <- struct{}{}:
		defer func() { <-mediaResolveSem }()
	case <-ctx.Done():
		return "", "", ctx.Err()
	}

	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", true),
		chromedp.Flag("no-sandbox", true),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("mute-audio", true),
		chromedp.Flag("autoplay-policy", "no-user-gesture-required"),
		// 关闭站点隔离：视频通常在跨域 iframe（解析网关）里加载，
		// 不关的话子框架是独立 target，主 target 的 ListenTarget 收不到它的网络事件。
		chromedp.Flag("disable-site-isolation-trials", true),
		chromedp.Flag("disable-features", "IsolateOrigins,site-per-process"),
		chromedp.UserAgent(mediaResolveUA),
	)
	if mediaResolveProxy != "" {
		opts = append(opts, chromedp.ProxyServer(mediaResolveProxy))
	}
	if mediaResolveExecPath != "" {
		opts = append(opts, chromedp.ExecPath(mediaResolveExecPath))
	}

	allocCtx, cancelAlloc := chromedp.NewExecAllocator(context.Background(), opts...)
	defer cancelAlloc()
	browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
	defer cancelBrowser()
	runCtx, cancelRun := context.WithTimeout(browserCtx, mediaResolveTimeout)
	defer cancelRun()

	hit := make(chan [2]string, 1)
	chromedp.ListenTarget(browserCtx, func(ev interface{}) {
		var candidate string
		switch e := ev.(type) {
		case *network.EventRequestWillBeSent:
			candidate = e.Request.URL
		case *network.EventResponseReceived:
			candidate = e.Response.URL
		default:
			return
		}
		if candidate == "" || mediaHitDenyPattern.MatchString(candidate) {
			return
		}
		if !mediaHitPattern.MatchString(candidate) {
			return
		}
		kind := "mp4"
		if strings.Contains(strings.ToLower(candidate), "m3u8") {
			kind = "hls"
		}
		select {
		case hit <- [2]string{candidate, kind}:
		default:
		}
	})

	// 导航异步跑：媒体请求往往在页面完全加载前就发出，
	// 阻塞等 Run 返回会错过监听窗口，因此边导航边等命中。
	// 但导航错误必须留住——否则 chromium 没装/启动失败会被误报成“解析超时”。
	navErr := make(chan error, 1)
	go func() { navErr <- chromedp.Run(runCtx, network.Enable(), chromedp.Navigate(pageURL)) }()

	// 部分播放器需要点一下才起播，尝试静音自动播放各层 iframe
	tryPlay := func() {
		_ = chromedp.Run(runCtx, chromedp.ActionFunc(func(ctx context.Context) error {
			_ = chromedp.Evaluate(`(()=>{const v=document.querySelector('video');if(v){v.muted=true;v.play&&v.play().catch(()=>{});}return 1})()`, nil).Do(ctx)
			return nil
		}))
	}

	deadline := time.NewTimer(mediaResolveTimeout)
	defer deadline.Stop()
	poke := time.NewTicker(3 * time.Second)
	defer poke.Stop()
	for {
		select {
		case found := <-hit:
			return found[0], found[1], nil
		case err := <-navErr:
			// 命中可能与导航返回同时到达，优先取命中
			select {
			case found := <-hit:
				return found[0], found[1], nil
			default:
			}
			if err != nil {
				return "", "", errShort("解析失败：无法启动或打开页面（确认服务器已安装 chromium）：" + err.Error())
			}
			// 导航成功返回但还没命中，继续等媒体请求
			navErr = nil
		case <-poke.C:
			tryPlay()
		case <-deadline.C:
			return "", "", errShort("解析超时：未在页面里捕获到可播放的视频直链")
		case <-runCtx.Done():
			return "", "", errShort("解析超时：未在页面里捕获到可播放的视频直链")
		case <-ctx.Done():
			return "", "", ctx.Err()
		}
	}
}

type shortErr string

func (e shortErr) Error() string { return string(e) }

func errShort(msg string) error { return shortErr(msg) }

package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"path"
	"strings"

	"github.com/gin-gonic/gin"
)

// hlsDownloadPlan 描述一次「拼成单个文件」下载需要按顺序拉取的资源。
type hlsDownloadPlan struct {
	initSegment     string
	segments        []string
	isFragmentedMP4 bool
}

// sources 返回真正要顺序写入响应体的地址（init 段在最前）。
func (p hlsDownloadPlan) sources() []string {
	if p.initSegment == "" {
		return p.segments
	}
	return append([]string{p.initSegment}, p.segments...)
}

// extension 返回拼接产物应有的扩展名。
func (p hlsDownloadPlan) extension() string {
	if p.isFragmentedMP4 {
		return ".mp4"
	}
	return ".ts"
}

// DownloadHLS 把 HLS 播放列表拼成单个文件流返回，交给浏览器原生下载。
//
// 与 ProxyMedia 的 download=1 的区别：那条路只能代理「单个 URL」，遇到 m3u8 只会把清单
// 本身改写后返回；这里要解析清单、按顺序拉分片，并边拉边写响应体，因此不会把整部视频
// 驻留内存（后端内存是 O(单个分片)）。
//
// 已知限制（有意取舍）：
//   - 拼接后的响应是单向流，没有 Content-Length，也不支持 Range，因此浏览器能显示
//     下载进度但不能断点续传；
//   - 分片在中途失败时响应已开始下发，无法再改状态码，只能中断（浏览器侧表现为下载失败）；
//     只有首个分片失败时还来得及返回 502。
func (h *Handler) DownloadHLS(c *gin.Context) {
	setMediaProxyCORS(c)
	if c.Request.Method == http.MethodOptions {
		c.Status(http.StatusNoContent)
		return
	}

	target, err := validateMediaProxyTarget(c.Request.Context(), strings.TrimSpace(c.Query("url")))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	client := mediaProxyHTTPClient()
	manifest, manifestBase, err := fetchHLSDownloadManifest(c.Request.Context(), client, target)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	plan, err := buildHLSDownloadPlan(manifest, manifestBase)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	filename := resolveDownloadFilename(c.Query("filename"), manifestBase, plan)
	contentType := "video/mp2t"
	if plan.isFragmentedMP4 {
		contentType = "video/mp4"
	}
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", contentDispositionAttachment(filename))
	c.Header("Cache-Control", "no-store")

	sources := plan.sources()
	for index, source := range sources {
		if err := streamMediaSource(c, client, source); err != nil {
			log.Printf("[media-download] 分片 %d/%d 失败 url=%s err=%v", index+1, len(sources), source, err)
			if index == 0 && !c.Writer.Written() {
				c.JSON(http.StatusBadGateway, gin.H{"error": "分片拉取失败"})
			}
			return
		}
		// 立即下发，让浏览器尽早开始落盘（也避免中间缓冲过大）
		c.Writer.Flush()
	}
}

// fetchHLSDownloadManifest 取清单；若拿到的是多码率主清单，继续取第一个变体的清单
// （与前端 assembleHLSDownload 的选择策略一致）。
func fetchHLSDownloadManifest(ctx context.Context, client *http.Client, target *url.URL) (string, *url.URL, error) {
	manifest, base, err := fetchManifestText(ctx, client, target)
	if err != nil {
		return "", nil, err
	}
	if variant, ok := firstHLSVariant(manifest); ok {
		variantURL, err := resolveMediaReference(variant, base)
		if err != nil {
			return "", nil, fmt.Errorf("主清单变体地址无法解析: %w", err)
		}
		if _, err := validateParsedMediaProxyTarget(ctx, variantURL); err != nil {
			return "", nil, err
		}
		manifest, base, err = fetchManifestText(ctx, client, variantURL)
		if err != nil {
			return "", nil, err
		}
	}
	return manifest, base, nil
}

// fetchManifestText 拉取并限制大小的清单文本，同时返回重定向后的最终地址（用于解析相对分片）。
func fetchManifestText(ctx context.Context, client *http.Client, target *url.URL) (string, *url.URL, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return "", nil, errors.New("invalid media url")
	}
	setUpstreamMediaHeaders(request, target)
	response, err := client.Do(request)
	if err != nil {
		return "", nil, errors.New("media upstream request failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", nil, fmt.Errorf("清单拉取失败(%d)", response.StatusCode)
	}
	body, err := readMediaProxyManifest(response.Body)
	if err != nil {
		return "", nil, err
	}
	base := target
	if response.Request != nil && response.Request.URL != nil {
		base = response.Request.URL
	}
	return string(body), base, nil
}

// streamMediaSource 拉取单个分片并写入响应体（不整片缓存）。
func streamMediaSource(c *gin.Context, client *http.Client, rawURL string) error {
	target, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	if _, err := validateParsedMediaProxyTarget(c.Request.Context(), target); err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, target.String(), nil)
	if err != nil {
		return err
	}
	setUpstreamMediaHeaders(request, target)
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("分片拉取失败(%d)", response.StatusCode)
	}
	_, err = io.Copy(c.Writer, response.Body)
	return err
}

// firstHLSVariant 取出多码率主清单里第一个变体的地址。
func firstHLSVariant(manifest string) (string, bool) {
	if !strings.Contains(manifest, "#EXT-X-STREAM-INF") {
		return "", false
	}
	lines := splitManifestLines(manifest)
	for index := 1; index < len(lines); index++ {
		if !strings.HasPrefix(lines[index-1], "#EXT-X-STREAM-INF") {
			continue
		}
		if lines[index] == "" || strings.HasPrefix(lines[index], "#") {
			continue
		}
		return lines[index], true
	}
	return "", false
}

// buildHLSDownloadPlan 解析媒体清单，得到 init 段 + 分片顺序与产物类型。
func buildHLSDownloadPlan(manifest string, base *url.URL) (hlsDownloadPlan, error) {
	if !strings.Contains(manifest, "#EXT-X-ENDLIST") {
		return hlsDownloadPlan{}, errors.New("直播/无结尾的流无法下载为本地文件")
	}

	plan := hlsDownloadPlan{initSegment: hlsInitSegment(manifest, base)}
	for _, line := range splitManifestLines(manifest) {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		resolved := resolveMediaReferenceString(line, base)
		if resolved == "" {
			continue
		}
		plan.segments = append(plan.segments, resolved)
	}
	if len(plan.segments) == 0 {
		return hlsDownloadPlan{}, errors.New("清单里没有可下载的分片")
	}
	plan.isFragmentedMP4 = plan.initSegment != "" || isFragmentedMP4Segment(plan.segments[0])
	return plan, nil
}

// hlsInitSegment 取 #EXT-X-MAP 的 init 段地址（fMP4 必须把它拼在媒体段之前）。
func hlsInitSegment(manifest string, base *url.URL) string {
	for _, line := range splitManifestLines(manifest) {
		if !strings.HasPrefix(line, "#EXT-X-MAP") {
			continue
		}
		match := hlsURIAttributePattern.FindStringSubmatch(line)
		if len(match) == 2 {
			return resolveMediaReferenceString(match[1], base)
		}
	}
	return ""
}

func splitManifestLines(manifest string) []string {
	rawLines := strings.Split(manifest, "\n")
	lines := make([]string, 0, len(rawLines))
	for _, line := range rawLines {
		lines = append(lines, strings.TrimSpace(strings.TrimSuffix(line, "\r")))
	}
	return lines
}

func resolveMediaReference(rawRef string, base *url.URL) (*url.URL, error) {
	ref := strings.TrimSpace(rawRef)
	if ref == "" {
		return nil, errors.New("empty reference")
	}
	parsed, err := url.Parse(ref)
	if err != nil {
		return nil, err
	}
	resolved := base.ResolveReference(parsed)
	if resolved.Scheme != "http" && resolved.Scheme != "https" {
		return nil, errors.New("reference must use http or https")
	}
	return resolved, nil
}

func resolveMediaReferenceString(rawRef string, base *url.URL) string {
	resolved, err := resolveMediaReference(rawRef, base)
	if err != nil {
		return ""
	}
	return resolved.String()
}

func isFragmentedMP4Segment(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	switch strings.ToLower(path.Ext(parsed.Path)) {
	case ".m4s", ".mp4":
		return true
	default:
		return false
	}
}

// resolveDownloadFilename 决定落盘文件名：优先用前端传来的标题，否则从清单地址推导。
func resolveDownloadFilename(rawQuery string, manifestBase *url.URL, plan hlsDownloadPlan) string {
	extension := plan.extension()
	if name := sanitizeDownloadFilename(rawQuery); name != "" {
		if !strings.HasSuffix(strings.ToLower(name), extension) {
			name = strings.TrimSuffix(name, path.Ext(name)) + extension
		}
		return name
	}
	base := sanitizeDownloadFilename(strings.TrimSuffix(path.Base(manifestBase.Path), path.Ext(manifestBase.Path)))
	if base == "" || base == "." {
		base = "media"
	}
	return base + extension
}

// sanitizeDownloadFilename 去掉路径分隔符与控制字符，避免响应头注入与落盘越界。
func sanitizeDownloadFilename(raw string) string {
	value := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '/' || r == '\\' || r == '"' {
			return -1
		}
		return r
	}, raw)
	value = strings.TrimSpace(value)
	if runes := []rune(value); len(runes) > 120 {
		value = string(runes[:120])
	}
	return value
}

// contentDispositionAttachment 同时给出 ASCII 兜底名与 RFC 5987 的 UTF-8 名，
// 这样中文标题下载后不会变成乱码或 download。
func contentDispositionAttachment(filename string) string {
	ascii := sanitizeDownloadFilename(filename)
	if ascii == "" {
		ascii = "media"
	}
	ascii = strings.Map(func(r rune) rune {
		if r > 0x7f {
			return '_'
		}
		return r
	}, ascii)
	return fmt.Sprintf("attachment; filename=%q; filename*=UTF-8''%s", ascii, url.PathEscape(filename))
}

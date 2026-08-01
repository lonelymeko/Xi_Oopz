package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	mediaProxyTimeout       = 30 * time.Second
	mediaProxyManifestLimit = 8 << 20
	mediaProxyMaxRedirects  = 5
)

var hlsURIAttributePattern = regexp.MustCompile(`URI="([^"]+)"`)

func (h *Handler) ProxyMedia(c *gin.Context) {
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

	upstreamReq, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, target.String(), nil)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid media url"})
		return
	}
	copyMediaProxyRequestHeaders(c.Request, upstreamReq, target)

	client := &http.Client{
		Timeout: mediaProxyTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= mediaProxyMaxRedirects {
				return http.ErrUseLastResponse
			}
			_, err := validateParsedMediaProxyTarget(req.Context(), req.URL)
			return err
		},
	}
	resp, err := client.Do(upstreamReq)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "media upstream request failed"})
		return
	}
	defer resp.Body.Close()

	contentType := resp.Header.Get("Content-Type")
	proxySegments := c.Query("segments") == "1"
	proxyKey := c.Query("kind") == "key"
	downloadMode := c.Query("download") == "1"
	if downloadMode && !isHLSManifest(target, contentType) {
		// 下载模式：任意内容原样透传，并带 attachment 让浏览器落盘而不是播放
		copyMediaProxyResponseHeaders(c.Writer.Header(), resp.Header, target, contentType)
		c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", mediaDownloadFilename(target)))
		c.Status(resp.StatusCode)
		_, _ = io.Copy(c.Writer, resp.Body)
		return
	}
	if isHLSManifest(target, contentType) {
		body, err := readMediaProxyManifest(resp.Body)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		body = []byte(rewriteHLSManifest(string(body), target, proxySegments))
		c.Header("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8")
		c.Header("Cache-Control", "no-store")
		c.Header("Content-Length", fmt.Sprintf("%d", len(body)))
		c.Status(resp.StatusCode)
		_, _ = c.Writer.Write(body)
		return
	}
	if !proxySegments && !proxyKey {
		c.JSON(http.StatusBadRequest, gin.H{"error": "media proxy only supports hls manifests by default"})
		return
	}

	copyMediaProxyResponseHeaders(c.Writer.Header(), resp.Header, target, contentType)
	c.Status(resp.StatusCode)
	_, _ = io.Copy(c.Writer, resp.Body)
}

// 从目标 URL 路径推导下载文件名，取不出可用名时兜底 media。
func mediaDownloadFilename(target *url.URL) string {
	base := path.Base(target.Path)
	if base == "" || base == "." || base == "/" {
		return "media"
	}
	return base
}

func setMediaProxyCORS(c *gin.Context) {
	origin := c.GetHeader("Origin")
	if origin == "" {
		origin = "*"
		c.Header("Access-Control-Allow-Origin", origin)
		return
	}
	c.Header("Access-Control-Allow-Origin", origin)
	c.Header("Vary", "Origin")
	c.Header("Access-Control-Allow-Methods", "GET, OPTIONS")
	c.Header("Access-Control-Allow-Headers", "Range, Accept, Content-Type")
	c.Header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
}

func copyMediaProxyRequestHeaders(source *http.Request, target *http.Request, targetURL *url.URL) {
	target.Header.Set("User-Agent", "Mozilla/5.0 (compatible; OOPZ-MediaProxy/1.0)")
	target.Header.Set("Referer", (&url.URL{Scheme: targetURL.Scheme, Host: targetURL.Host, Path: "/"}).String())
	if accept := source.Header.Get("Accept"); accept != "" {
		target.Header.Set("Accept", accept)
	}
	if rangeHeader := source.Header.Get("Range"); rangeHeader != "" {
		target.Header.Set("Range", rangeHeader)
	}
}

func copyMediaProxyResponseHeaders(dst http.Header, src http.Header, target *url.URL, contentType string) {
	if contentType == "" {
		contentType = mime.TypeByExtension(strings.ToLower(path.Ext(target.Path)))
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	dst.Set("Content-Type", contentType)
	for _, key := range []string{"Content-Length", "Content-Range", "Accept-Ranges", "Cache-Control", "ETag", "Last-Modified"} {
		if value := src.Get(key); value != "" {
			dst.Set(key, value)
		}
	}
}

func readMediaProxyManifest(reader io.Reader) ([]byte, error) {
	limited := io.LimitReader(reader, mediaProxyManifestLimit+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, errors.New("failed to read media manifest")
	}
	if len(body) > mediaProxyManifestLimit {
		return nil, errors.New("media manifest is too large")
	}
	return body, nil
}

func isHLSManifest(target *url.URL, contentType string) bool {
	contentType = strings.ToLower(contentType)
	if strings.Contains(contentType, "application/vnd.apple.mpegurl") ||
		strings.Contains(contentType, "application/x-mpegurl") ||
		strings.Contains(contentType, "audio/mpegurl") {
		return true
	}
	return isLikelyHLSManifestPath(target.Path)
}

func isLikelyHLSManifestPath(value string) bool {
	pathValue := strings.ToLower(value)
	return strings.EqualFold(path.Ext(pathValue), ".m3u8") ||
		path.Base(pathValue) == "m3u8" ||
		strings.Contains(pathValue, ".m3u8/") ||
		strings.Contains(pathValue, "/m3u8/")
}

func rewriteHLSManifest(manifest string, baseURL *url.URL, proxySegments bool) string {
	lines := strings.SplitAfter(manifest, "\n")
	targetDuration := normalizedHLSTargetDuration(lines)
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if targetDuration > 0 && strings.HasPrefix(trimmed, "#EXT-X-TARGETDURATION:") {
			lines[index] = strings.Replace(line, trimmed, fmt.Sprintf("#EXT-X-TARGETDURATION:%d", targetDuration), 1)
			continue
		}
		if strings.HasPrefix(trimmed, "#") {
			lines[index] = hlsURIAttributePattern.ReplaceAllStringFunc(line, func(match string) string {
				parts := hlsURIAttributePattern.FindStringSubmatch(match)
				if len(parts) != 2 {
					return match
				}
				return `URI="` + proxiedHLSReference(parts[1], baseURL, proxySegments, trimmed) + `"`
			})
			continue
		}
		lines[index] = strings.Replace(line, trimmed, proxiedHLSReference(trimmed, baseURL, proxySegments, trimmed), 1)
	}
	return strings.Join(lines, "")
}

func normalizedHLSTargetDuration(lines []string) int {
	var maxDuration float64
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "#EXTINF:") {
			continue
		}
		durationText := strings.TrimPrefix(trimmed, "#EXTINF:")
		if comma := strings.Index(durationText, ","); comma >= 0 {
			durationText = durationText[:comma]
		}
		var duration float64
		if _, err := fmt.Sscanf(durationText, "%f", &duration); err != nil {
			continue
		}
		if duration > maxDuration {
			maxDuration = duration
		}
	}
	if maxDuration <= 0 {
		return 0
	}
	return int(math.Ceil(maxDuration))
}

func proxiedHLSReference(rawRef string, baseURL *url.URL, proxySegments bool, manifestLine string) string {
	ref := strings.TrimSpace(rawRef)
	if ref == "" || strings.HasPrefix(strings.ToLower(ref), "data:") || strings.HasPrefix(strings.ToLower(ref), "blob:") {
		return rawRef
	}
	parsed, err := url.Parse(ref)
	if err != nil {
		return rawRef
	}
	if parsed.Scheme != "" && parsed.Scheme != "http" && parsed.Scheme != "https" {
		return rawRef
	}
	resolved := baseURL.ResolveReference(parsed)
	if resolved.Scheme != "http" && resolved.Scheme != "https" {
		return rawRef
	}
	if !proxySegments && !shouldProxyHLSReferenceWithoutSegments(resolved, manifestLine) {
		return resolved.String()
	}
	query := url.Values{}
	query.Set("url", resolved.String())
	if proxySegments {
		query.Set("segments", "1")
	}
	if isHLSKeyReference(manifestLine) {
		query.Set("kind", "key")
	}
	if shouldProxyHLSManifestReference(resolved) {
		return "/api/media/proxy.m3u8?" + query.Encode()
	}
	return "/api/media/proxy?" + query.Encode()
}

func shouldProxyHLSReferenceWithoutSegments(resolved *url.URL, manifestLine string) bool {
	if shouldProxyHLSManifestReference(resolved) {
		return true
	}
	return isHLSKeyReference(manifestLine)
}

func shouldProxyHLSManifestReference(resolved *url.URL) bool {
	return isLikelyHLSManifestPath(resolved.Path)
}

func isHLSKeyReference(manifestLine string) bool {
	return strings.HasPrefix(manifestLine, "#EXT-X-KEY")
}

func validateMediaProxyTarget(ctx context.Context, rawTarget string) (*url.URL, error) {
	if rawTarget == "" {
		return nil, errors.New("media url is required")
	}
	target, err := url.Parse(rawTarget)
	if err != nil {
		return nil, errors.New("invalid media url")
	}
	return validateParsedMediaProxyTarget(ctx, target)
}

func validateParsedMediaProxyTarget(ctx context.Context, target *url.URL) (*url.URL, error) {
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, errors.New("media url must use http or https")
	}
	if target.Hostname() == "" {
		return nil, errors.New("media url host is required")
	}
	if target.User != nil {
		return nil, errors.New("media url user info is not allowed")
	}
	if err := validateMediaProxyHost(ctx, target.Hostname()); err != nil {
		return nil, err
	}
	return target, nil
}

func validateMediaProxyHost(ctx context.Context, hostname string) error {
	if addr, err := netip.ParseAddr(hostname); err == nil {
		if isBlockedMediaProxyAddr(addr) {
			return errors.New("media url host is not allowed")
		}
		return nil
	}

	lookupCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupIPAddr(lookupCtx, hostname)
	if err != nil || len(addrs) == 0 {
		return errors.New("media url host cannot be resolved")
	}
	for _, item := range addrs {
		addr, ok := netip.AddrFromSlice(item.IP)
		if !ok || isBlockedMediaProxyAddr(addr.Unmap()) {
			return errors.New("media url host is not allowed")
		}
	}
	return nil
}

func isBlockedMediaProxyAddr(addr netip.Addr) bool {
	return !addr.IsValid() ||
		addr.IsUnspecified() ||
		addr.IsLoopback() ||
		addr.IsPrivate() ||
		addr.IsLinkLocalUnicast() ||
		addr.IsLinkLocalMulticast() ||
		addr.IsMulticast()
}

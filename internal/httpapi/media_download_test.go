package httpapi

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %s: %v", raw, err)
	}
	return parsed
}

func TestBuildHLSDownloadPlanForTransportStreamSegments(t *testing.T) {
	base := mustParseURL(t, "https://cdn.example.com/vod/index.m3u8")
	manifest := strings.Join([]string{
		"#EXTM3U",
		"#EXT-X-TARGETDURATION:4",
		"#EXTINF:4,",
		"seg-1.ts",
		"#EXTINF:4,",
		"https://media.example.net/vod/seg-2.ts?sig=abc",
		"#EXT-X-ENDLIST",
		"",
	}, "\n")

	plan, err := buildHLSDownloadPlan(manifest, base)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.isFragmentedMP4 {
		t.Fatalf("TS 分片不应判定为 fMP4")
	}
	if plan.extension() != ".ts" {
		t.Fatalf("extension = %q, want .ts", plan.extension())
	}
	want := []string{
		"https://cdn.example.com/vod/seg-1.ts",
		"https://media.example.net/vod/seg-2.ts?sig=abc",
	}
	if len(plan.segments) != len(want) {
		t.Fatalf("segments = %v, want %v", plan.segments, want)
	}
	for index := range want {
		if plan.segments[index] != want[index] {
			t.Fatalf("segments[%d] = %q, want %q", index, plan.segments[index], want[index])
		}
	}
	if plan.initSegment != "" {
		t.Fatalf("TS 清单不应有 init 段，得到 %q", plan.initSegment)
	}
}

func TestBuildHLSDownloadPlanPutsInitSegmentFirstForFragmentedMP4(t *testing.T) {
	base := mustParseURL(t, "https://cdn.example.com/vod/index.m3u8")
	manifest := strings.Join([]string{
		"#EXTM3U",
		`#EXT-X-MAP:URI="init.mp4"`,
		"#EXTINF:4,",
		"chunk-1.m4s",
		"#EXT-X-ENDLIST",
		"",
	}, "\n")

	plan, err := buildHLSDownloadPlan(manifest, base)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !plan.isFragmentedMP4 || plan.extension() != ".mp4" {
		t.Fatalf("应判定为 fMP4/mp4，得到 fmp4=%v ext=%q", plan.isFragmentedMP4, plan.extension())
	}
	sources := plan.sources()
	if len(sources) != 2 || sources[0] != "https://cdn.example.com/vod/init.mp4" {
		t.Fatalf("init 段必须排在最前，得到 %v", sources)
	}
}

func TestBuildHLSDownloadPlanDetectsFragmentedMP4WithoutMap(t *testing.T) {
	base := mustParseURL(t, "https://cdn.example.com/vod/index.m3u8")
	manifest := strings.Join([]string{
		"#EXTM3U",
		"#EXTINF:4,",
		"chunk-1.m4s",
		"#EXT-X-ENDLIST",
		"",
	}, "\n")

	plan, err := buildHLSDownloadPlan(manifest, base)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !plan.isFragmentedMP4 {
		t.Fatalf("首个分片是 .m4s 时应判定为 fMP4")
	}
}

func TestBuildHLSDownloadPlanRejectsLiveStream(t *testing.T) {
	base := mustParseURL(t, "https://cdn.example.com/live/index.m3u8")
	manifest := strings.Join([]string{"#EXTM3U", "#EXTINF:4,", "seg-1.ts", ""}, "\n")

	_, err := buildHLSDownloadPlan(manifest, base)
	if err == nil || !strings.Contains(err.Error(), "直播") {
		t.Fatalf("无 ENDLIST 的直播流应被拒绝，得到 err=%v", err)
	}
}

func TestBuildHLSDownloadPlanRejectsEmptyPlaylist(t *testing.T) {
	base := mustParseURL(t, "https://cdn.example.com/vod/index.m3u8")
	manifest := strings.Join([]string{"#EXTM3U", "#EXT-X-ENDLIST", ""}, "\n")

	if _, err := buildHLSDownloadPlan(manifest, base); err == nil {
		t.Fatalf("没有分片时应报错")
	}
}

func TestFirstHLSVariant(t *testing.T) {
	master := strings.Join([]string{
		"#EXTM3U",
		"#EXT-X-STREAM-INF:BANDWIDTH=800000",
		"720p/index.m3u8",
		"#EXT-X-STREAM-INF:BANDWIDTH=2000000",
		"1080p/index.m3u8",
		"",
	}, "\n")
	variant, ok := firstHLSVariant(master)
	if !ok || variant != "720p/index.m3u8" {
		t.Fatalf("应取第一个变体，得到 %q ok=%v", variant, ok)
	}

	media := strings.Join([]string{"#EXTM3U", "#EXTINF:4,", "seg-1.ts", "#EXT-X-ENDLIST", ""}, "\n")
	if _, ok := firstHLSVariant(media); ok {
		t.Fatalf("媒体清单不应被识别为主清单")
	}
}

func TestResolveDownloadFilename(t *testing.T) {
	base := mustParseURL(t, "https://cdn.example.com/vod/movie/index.m3u8")
	tsPlan := hlsDownloadPlan{segments: []string{"https://cdn.example.com/vod/movie/seg-1.ts"}}
	mp4Plan := hlsDownloadPlan{initSegment: "https://cdn.example.com/vod/movie/init.mp4", segments: []string{"x.m4s"}, isFragmentedMP4: true}

	if got := resolveDownloadFilename("我的影片", base, mp4Plan); got != "我的影片.mp4" {
		t.Fatalf("中文标题应保留并补扩展名，得到 %q", got)
	}
	if got := resolveDownloadFilename("标题.m3u8", base, tsPlan); got != "标题.ts" {
		t.Fatalf("应把 .m3u8 换成 .ts，得到 %q", got)
	}
	if got := resolveDownloadFilename("", base, tsPlan); got != "index.ts" {
		t.Fatalf("无标题时应从清单地址推导，得到 %q", got)
	}
	// 路径分隔符与控制字符必须被清掉，避免响应头注入与落盘越界
	if got := resolveDownloadFilename("../../etc/passwd\n", base, tsPlan); strings.ContainsAny(got, "/\\\n") {
		t.Fatalf("危险字符未被清理: %q", got)
	}
}

func TestContentDispositionAttachmentCarriesUTF8Name(t *testing.T) {
	header := contentDispositionAttachment("测试 影片.mp4")
	if !strings.HasPrefix(header, "attachment;") {
		t.Fatalf("缺少 attachment: %q", header)
	}
	if !strings.Contains(header, "filename*=UTF-8''") {
		t.Fatalf("缺少 RFC 5987 的 UTF-8 文件名: %q", header)
	}
	if strings.ContainsAny(header, "\r\n") {
		t.Fatalf("响应头出现换行: %q", header)
	}
}

// 新接口同样必须走 SSRF 校验：内网/回环地址要在拉取任何内容前就被拒绝。
func TestDownloadHLSRejectsBlockedTarget(t *testing.T) {
	gin.SetMode(gin.TestMode)
	handler := &Handler{}

	for _, raw := range []string{
		"http://127.0.0.1:8080/vod/index.m3u8",
		"http://10.0.0.5/vod/index.m3u8",
		"file:///etc/passwd",
		"",
	} {
		recorder := httptest.NewRecorder()
		context, _ := gin.CreateTestContext(recorder)
		context.Request = httptest.NewRequest(http.MethodGet, "/api/media/download.m3u8?url="+url.QueryEscape(raw), nil)

		handler.DownloadHLS(context)

		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("url=%q 应返回 400，得到 %d", raw, recorder.Code)
		}
	}
}

package httpapi

import (
	"net/netip"
	"net/url"
	"strings"
	"testing"
)

func TestRewriteHLSManifestProxiesMediaReferencesWhenEnabled(t *testing.T) {
	base, err := url.Parse("https://cdn.example.com/live/master/index.m3u8?token=abc")
	if err != nil {
		t.Fatal(err)
	}

	manifest := strings.Join([]string{
		"#EXTM3U",
		`#EXT-X-KEY:METHOD=AES-128,URI="key.bin"`,
		`#EXT-X-MAP:URI="/init.mp4"`,
		"segment-001.ts",
		"https://media.example.net/next/segment-002.ts?sig=123",
		"data:text/plain;base64,AAAA",
		"",
	}, "\n")

	rewritten := rewriteHLSManifest(manifest, base, true)

	for _, expected := range []string{
		`URI="/api/media/proxy?kind=key&segments=1&url=https%3A%2F%2Fcdn.example.com%2Flive%2Fmaster%2Fkey.bin"`,
		`URI="/api/media/proxy?segments=1&url=https%3A%2F%2Fcdn.example.com%2Finit.mp4"`,
		"/api/media/proxy?segments=1&url=https%3A%2F%2Fcdn.example.com%2Flive%2Fmaster%2Fsegment-001.ts",
		"/api/media/proxy?segments=1&url=https%3A%2F%2Fmedia.example.net%2Fnext%2Fsegment-002.ts%3Fsig%3D123",
		"data:text/plain;base64,AAAA",
	} {
		if !strings.Contains(rewritten, expected) {
			t.Fatalf("rewritten manifest missing %q:\n%s", expected, rewritten)
		}
	}
}

func TestRewriteHLSManifestLeavesSegmentsDirectByDefault(t *testing.T) {
	base, err := url.Parse("https://cdn.example.com/live/master/index.m3u8?token=abc")
	if err != nil {
		t.Fatal(err)
	}

	manifest := strings.Join([]string{
		"#EXTM3U",
		`#EXT-X-KEY:METHOD=AES-128,URI="key.bin"`,
		`#EXT-X-MAP:URI="/init.mp4"`,
		"variant.m3u8",
		"segment-001.ts",
		"https://media.example.net/next/segment-002.ts?sig=123",
		"",
	}, "\n")

	rewritten := rewriteHLSManifest(manifest, base, false)

	for _, expected := range []string{
		`URI="/api/media/proxy?kind=key&url=https%3A%2F%2Fcdn.example.com%2Flive%2Fmaster%2Fkey.bin"`,
		`URI="https://cdn.example.com/init.mp4"`,
		"/api/media/proxy.m3u8?url=https%3A%2F%2Fcdn.example.com%2Flive%2Fmaster%2Fvariant.m3u8",
		"https://cdn.example.com/live/master/segment-001.ts",
		"https://media.example.net/next/segment-002.ts?sig=123",
	} {
		if !strings.Contains(rewritten, expected) {
			t.Fatalf("rewritten manifest missing %q:\n%s", expected, rewritten)
		}
	}
}

func TestRewriteHLSManifestNormalizesTargetDuration(t *testing.T) {
	base, err := url.Parse("https://cdn.example.com/video/index.m3u8")
	if err != nil {
		t.Fatal(err)
	}

	manifest := strings.Join([]string{
		"#EXTM3U",
		"#EXT-X-TARGETDURATION:1688",
		"#EXTINF:10.4503,",
		"segment-001.ts",
		"#EXTINF:20.854145,",
		"segment-002.ts",
		"#EXT-X-ENDLIST",
	}, "\n")

	rewritten := rewriteHLSManifest(manifest, base, false)

	if !strings.Contains(rewritten, "#EXT-X-TARGETDURATION:21") {
		t.Fatalf("target duration was not normalized:\n%s", rewritten)
	}
}

func TestIsHLSManifestDetectsExtensionlessM3U8Path(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want bool
	}{
		{name: "extension", raw: "https://cdn.example.com/video/index.m3u8?token=abc", want: true},
		{name: "extensionless endpoint", raw: "https://jx.example.com/playurl/m3u8?v=abc", want: true},
		{name: "nested endpoint", raw: "https://jx.example.com/playurl/m3u8/main?v=abc", want: true},
		{name: "mp4", raw: "https://cdn.example.com/video/demo.mp4", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			target, err := url.Parse(tt.raw)
			if err != nil {
				t.Fatal(err)
			}
			if got := isHLSManifest(target, ""); got != tt.want {
				t.Fatalf("isHLSManifest(%q) = %v, want %v", tt.raw, got, tt.want)
			}
		})
	}
}

func TestBlockedMediaProxyAddr(t *testing.T) {
	tests := []struct {
		name string
		addr string
		want bool
	}{
		{name: "loopback", addr: "127.0.0.1", want: true},
		{name: "private", addr: "10.1.2.3", want: true},
		{name: "link local", addr: "169.254.10.20", want: true},
		{name: "multicast", addr: "224.0.0.1", want: true},
		{name: "public", addr: "8.8.8.8", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			addr := netip.MustParseAddr(tt.addr)
			if got := isBlockedMediaProxyAddr(addr); got != tt.want {
				t.Fatalf("isBlockedMediaProxyAddr(%s) = %v, want %v", tt.addr, got, tt.want)
			}
		})
	}
}

func TestMediaDownloadFilename(t *testing.T) {
	cases := map[string]string{
		"https://cdn.example.com/videos/movie.mp4?sig=1": "movie.mp4",
		"https://cdn.example.com/":                       "media",
		"https://cdn.example.com":                        "media",
	}
	for raw, expected := range cases {
		target, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		if got := mediaDownloadFilename(target); got != expected {
			t.Fatalf("mediaDownloadFilename(%q) = %q, want %q", raw, got, expected)
		}
	}
}

package httpapi

import "testing"

func TestMediaHitPattern(t *testing.T) {
	hits := []string{
		"https://cdn.example.com/v/index.m3u8?token=1",
		"https://upos-sz-mirrorhw.bilivideo.com/x/262040750-1-208.mp4?e=abc",
		"https://jx.wuzhoupai.com:8443/playurl/m3u8?v=ABCD&k=EF",
		"https://jx.wuzhoupai.com:8443/playurl/30ac5d111c756f0544a3976611556798.m3u8?ckey=x",
	}
	for _, u := range hits {
		if !mediaHitPattern.MatchString(u) {
			t.Fatalf("expected media hit for %q", u)
		}
	}
	misses := []string{
		"https://www.agedm.io/play/20200096/1/1",
		"https://cdn.example.com/poster.jpg",
		"https://cdn.example.com/app.js",
	}
	for _, u := range misses {
		if mediaHitPattern.MatchString(u) {
			t.Fatalf("did not expect media hit for %q", u)
		}
	}
}

func TestMediaHitDenyPattern(t *testing.T) {
	if !mediaHitDenyPattern.MatchString("https://175.178.227.159:7788/Play/adposter.mp4") {
		t.Fatal("expected adposter.mp4 to be denied")
	}
	if mediaHitDenyPattern.MatchString("https://cdn.example.com/v/index.m3u8") {
		t.Fatal("did not expect normal m3u8 to be denied")
	}
}

func TestClassifyMediaCandidate(t *testing.T) {
	cases := []struct {
		name    string
		url     string
		mime    string
		isMedia bool
		wantOK  bool
		wantKnd string
	}{
		{"m3u8 by url", "https://jx/playurl/x.m3u8?ckey=1", "", false, true, "hls"},
		{"mp4 by url", "https://cdn/v/262040750-1-208.mp4?e=x", "", false, true, "mp4"},
		{"extensionless video by media type", "https://v16-vod.capcutvod.com/abc/video/tos/alisg/xyz/", "", true, true, "mp4"},
		{"extensionless hls by mime", "https://cdn/stream/live", "application/vnd.apple.mpegurl", false, true, "hls"},
		{"video mime no ext", "https://cdn/play/token123", "video/mp4", false, true, "mp4"},
		{"deny adposter even if media", "https://x/Play/adposter.mp4", "video/mp4", true, false, ""},
		{"blob ignored", "blob:https://site/uuid", "video/mp4", true, false, ""},
		{"wasm not media", "https://x/main.wasm", "application/octet-stream", false, false, ""},
		{"page url not media", "https://www.agedm.io/play/20200096/1/1", "text/html", false, false, ""},
		{"poster image ignored", "https://cdn/poster.jpg", "image/jpeg", false, false, ""},
	}
	for _, c := range cases {
		kind, ok := classifyMediaCandidate(c.url, c.mime, c.isMedia)
		if ok != c.wantOK || (ok && kind != c.wantKnd) {
			t.Fatalf("%s: got (%q,%v), want (%q,%v)", c.name, kind, ok, c.wantKnd, c.wantOK)
		}
	}
}

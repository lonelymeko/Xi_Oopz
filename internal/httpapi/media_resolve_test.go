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

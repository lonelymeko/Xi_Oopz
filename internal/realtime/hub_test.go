package realtime

import "testing"

func TestIsLikelyLiveScreeningURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		raw  string
		want bool
	}{
		{name: "empty", raw: "", want: false},
		{name: "hls vod playlist", raw: "https://cdn.example.com/movies/demo/index.m3u8", want: false},
		{name: "ordinary mp4", raw: "https://cdn.example.com/movies/demo.mp4", want: false},
		{name: "bilibili live page", raw: "https://live.bilibili.com/123", want: true},
		{name: "flv stream", raw: "https://cdn.example.com/live/stream.flv", want: true},
		{name: "live query flag", raw: "https://cdn.example.com/stream.m3u8?stream=live", want: true},
		{name: "livestream path", raw: "https://cdn.example.com/livestream/channel.m3u8", want: true},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := isLikelyLiveScreeningURL(tt.raw); got != tt.want {
				t.Fatalf("isLikelyLiveScreeningURL(%q) = %v, want %v", tt.raw, got, tt.want)
			}
		})
	}
}

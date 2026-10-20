package updates

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestReleaseMetadataIgnoresUnrelatedMalformedAssetsAndRecords(t *testing.T) {
	valid := strings.Replace(releaseJSON("v1.2.3"), `"size":42`, `"size":42.0`, 1)
	valid = strings.Replace(valid, `"assets":[`, `"assets":[null,{"name":5,"size":"invalid"},`, 1)
	for _, channel := range []string{"stable", "beta"} {
		t.Run(channel, func(t *testing.T) {
			body := valid
			if channel == "beta" {
				body = `[null,42,{"tag_name":9},` + valid + `]`
			}
			service := New(Options{Version: "1.0.0", HTTP: doerFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
			})})
			defer service.Close()
			result, err := service.Check(context.Background(), channel)
			if err != nil || result.LatestVersion != "1.2.3" || result.Asset == nil || result.Asset.Size != 42 {
				t.Fatal("unrelated malformed metadata hid a valid release")
			}
		})
	}
}

func TestReleaseDoesNotCoerceStringAssetSizeOrRequireAssetsForVersion(t *testing.T) {
	for _, body := range []string{strings.Replace(releaseJSON("v1.2.3"), `"size":42`, `"size":"42"`, 1), strings.Replace(releaseJSON("v1.2.3"), `"assets":[`, `"assets":[{"name":"dant_1.2.3_windows_x64_setup.exe"},`, 1)} {
		var release githubRelease
		if json.Unmarshal([]byte(body), &release) != nil {
			t.Fatal("fixture")
		}
		result := publishedRelease(release, "stable")
		if result == nil || result.asset != nil {
			t.Fatal("unsafe installer metadata accepted or release hidden")
		}
	}
}

package skills

import "testing"

func TestSaveBoundaryRejectsAmbiguousBinaryAssetMetadata(t *testing.T) {
	for _, asset := range []string{
		`null`,
		`{"encoding":"base64","mediaType":"application/octet-stream"}`,
		`{"encoding":null,"mediaType":"application/octet-stream","data":"AP8="}`,
		`{"encoding":"base64","mediaType":12,"data":"AP8="}`,
		`{"encoding":"base64","mediaType":"application/octet-stream","data":null}`,
		`{"encoding":"base64","mediaType":"application/octet-stream","data":"AP8=","unexpected":true}`,
	} {
		input := `{"name":"fixture","description":"A fixture","instructions":"Read the binary asset.","binaryFiles":{"assets/opaque.bin":` + asset + `}}`
		if _, err := DecodeSave([]byte(input)); err == nil {
			t.Fatalf("ambiguous binary metadata accepted: %s", asset)
		}
	}
}

func TestSaveBoundaryPreservesOpaqueBinaryAsset(t *testing.T) {
	input := []byte(`{"name":"fixture","description":"A fixture","instructions":"Read the binary asset.","binaryFiles":{"assets/opaque.bin":{"encoding":"base64","mediaType":"application/octet-stream","data":"AP8="}}}`)
	decoded, err := DecodeSave(input)
	if err != nil {
		t.Fatal(err)
	}
	asset := decoded.BinaryFiles["assets/opaque.bin"]
	if asset.Encoding != "base64" || asset.MediaType != "application/octet-stream" || asset.Data != "AP8=" {
		t.Fatal("binary metadata or encoded bytes changed at the boundary")
	}
}

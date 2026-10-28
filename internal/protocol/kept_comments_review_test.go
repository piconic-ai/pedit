package protocol

import "testing"

func TestCommentAnyIntegerAndLengthBoundaries(t *testing.T) {
	prefix := []byte{1, 1, 1, 0, 0x28, 1, 8, 'c', 'o', 'm', 'm', 'e', 'n', 't', 's', 1, 'k', 1}
	cases := []struct {
		name  string
		value []byte
		want  bool
	}{
		{"one", []byte{125, 1}, true},
		{"overlong integer", []byte{125, 0x81, 0}, false},
		{"negative zero", []byte{125, 0x40}, false},
		{"maximum safe", []byte{125, 0xbf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f}, true},
		{"minimum safe", []byte{125, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f}, true},
		{"negative unsafe", []byte{125, 0xc0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x20}, false},
		{"unsafe integer", []byte{125, 0x81, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x20}, false},
		{"overlong string length", []byte{119, 0x81, 0, 'x'}, false},
		{"overlong binary length", []byte{116, 0x81, 0, 1}, false},
		{"overlong array length", []byte{117, 0x81, 0, 126}, false},
		{"overlong object key length", []byte{118, 1, 0x81, 0, 'k', 126}, false},
		{"relative anchor bytes", []byte{116, 2, 1, 2}, true},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			b := append(append(append([]byte(nil), prefix...), tt.value...), 0)
			if got := CheckKeptCommentsState(b) == nil; got != tt.want {
				t.Fatalf("accepted=%v want=%v bytes=%x", got, tt.want, b)
			}
		})
	}
}

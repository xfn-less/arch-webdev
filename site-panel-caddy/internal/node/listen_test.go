package node

import "testing"

func TestParseListen(t *testing.T) {
	cases := []struct {
		in   string
		host string
		port int
	}{
		{"test.yyy.cn", "test.yyy.cn", 0},
		{"*.xxx.com", "*.xxx.com", 0},
		{"1.2.3.4:8888", "1.2.3.4", 8888},
		{"103.239.186.54:9999", "103.239.186.54", 9999},
	}
	for _, c := range cases {
		got, e := ParseListen(c.in)
		if e != nil || got.Host != c.host || got.Port != c.port {
			t.Fatalf("%q => %+v %v", c.in, got, e)
		}
	}
	for _, bad := range []string{"", "http://a.com", "a/b", "1.2.3.4:22", "*.*.com"} {
		if _, e := ParseListen(bad); e == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestExpandIPAlias(t *testing.T) {
	got, e := ExpandIPAlias([]string{"ip:10000", "z1.example.com", "ip"}, "103.239.186.54")
	if e != nil {
		t.Fatal(e)
	}
	want := []string{"103.239.186.54:10000", "z1.example.com", "103.239.186.54"}
	if len(got) != len(want) {
		t.Fatalf("%v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%d: %q != %q", i, got[i], want[i])
		}
	}
	if _, e := ExpandIPAlias([]string{"ip:10000"}, "not-an-ip"); e == nil {
		t.Fatal("expected error")
	}
}

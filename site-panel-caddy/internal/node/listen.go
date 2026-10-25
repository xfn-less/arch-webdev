package node

import (
	"fmt"
	"net"
	"strconv"
	"strings"
)

// Listen is one UI list row: domain, wildcard, IP, or host:port.
type Listen struct {
	Host string // hostname, *.example.com, or IP
	Port int    // 0 = not specified in the row
	Raw  string
}

func splitHostPortLoose(raw string) (host string, port int, err error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", 0, fmt.Errorf("空地址")
	}
	if strings.Contains(raw, "/") || strings.ContainsAny(raw, " \t\r\n") {
		return "", 0, fmt.Errorf("地址不能包含路径或空白")
	}
	lower := strings.ToLower(raw)
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
		return "", 0, fmt.Errorf("列表里只写主机，不要带 http://")
	}
	if strings.HasPrefix(raw, "[") {
		host, portText, e := net.SplitHostPort(raw)
		if e != nil {
			if ip := net.ParseIP(strings.Trim(raw, "[]")); ip != nil {
				return ip.String(), 0, nil
			}
			return "", 0, fmt.Errorf("IPv6 地址无效")
		}
		p, e := strconv.Atoi(portText)
		if e != nil || p < 1 || p > 65535 || p == 22 {
			return "", 0, fmt.Errorf("端口无效")
		}
		if net.ParseIP(host) == nil {
			return "", 0, fmt.Errorf("IPv6 地址无效")
		}
		return host, p, nil
	}
	if i := strings.LastIndexByte(raw, ':'); i > 0 {
		right := raw[i+1:]
		if portNum, e := strconv.Atoi(right); e == nil {
			host = raw[:i]
			if host == "" {
				return "", 0, fmt.Errorf("主机为空")
			}
			if portNum < 1 || portNum > 65535 || portNum == 22 {
				return "", 0, fmt.Errorf("端口无效或占用了 SSH 端口")
			}
			return host, portNum, nil
		}
	}
	return raw, 0, nil
}

func validHostname(host string) bool {
	if host == "" || strings.Contains(host, "..") || len(host) > 253 {
		return false
	}
	if strings.HasPrefix(host, "*.") {
		base := host[2:]
		if base == "" || strings.HasPrefix(base, "*") {
			return false
		}
		return hostPattern.MatchString(base)
	}
	return hostPattern.MatchString(host)
}

// ParseListen accepts: example.com | *.example.com | 1.2.3.4 | 1.2.3.4:8888
func ParseListen(raw string) (Listen, error) {
	host, port, e := splitHostPortLoose(raw)
	if e != nil {
		return Listen{}, e
	}
	host = strings.ToLower(strings.TrimSpace(host))
	if ip := net.ParseIP(host); ip != nil {
		out := Listen{Host: host, Port: port}
		if port > 0 {
			out.Raw = fmt.Sprintf("%s:%d", host, port)
		} else {
			out.Raw = host
		}
		return out, nil
	}
	if !validHostname(host) {
		return Listen{}, fmt.Errorf("域名/IP 无效: %q", raw)
	}
	out := Listen{Host: host, Port: port}
	if port > 0 {
		out.Raw = fmt.Sprintf("%s:%d", host, port)
	} else {
		out.Raw = host
	}
	return out, nil
}

func (l Listen) IsIP() bool       { return net.ParseIP(l.Host) != nil }
func (l Listen) IsWildcard() bool { return strings.HasPrefix(l.Host, "*.") }

// CaddyAddr renders one site address token for the generated Caddyfile.
func (l Listen) CaddyAddr(certMode string) string {
	host := l.Host
	if l.IsIP() && strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if l.Port > 0 {
		return fmt.Sprintf("http://%s:%d", host, l.Port)
	}
	if certMode == "off" || l.IsIP() {
		return "http://" + host
	}
	return host
}

// ExpandIPAlias is legacy compat for old saved rows like "ip:10000".
// UI no longer offers this shorthand; new data should store the real node IP.
func ExpandIPAlias(domains []string, nodeIP string) ([]string, error) {
	nodeIP = strings.TrimSpace(nodeIP)
	out := make([]string, 0, len(domains))
	for _, raw := range domains {
		l, e := ParseListen(raw)
		if e != nil {
			return nil, e
		}
		if strings.EqualFold(l.Host, "ip") {
			if net.ParseIP(nodeIP) == nil {
				return nil, fmt.Errorf("域名写了 ip / ip:端口，但节点主机不是 IP：%s", nodeIP)
			}
			l.Host = strings.ToLower(nodeIP)
			if l.Port > 0 {
				l.Raw = fmt.Sprintf("%s:%d", l.Host, l.Port)
			} else {
				l.Raw = l.Host
			}
		}
		out = append(out, l.Raw)
	}
	return out, nil
}

func ParseListens(domains []string) ([]Listen, error) {
	out := make([]Listen, 0, len(domains))
	seen := map[string]bool{}
	for _, raw := range domains {
		l, e := ParseListen(raw)
		if e != nil {
			return nil, e
		}
		if seen[l.Raw] {
			return nil, fmt.Errorf("重复地址: %s", l.Raw)
		}
		seen[l.Raw] = true
		out = append(out, l)
	}
	return out, nil
}

// PrimaryPort picks the first explicit port in the list; otherwise fallback/80.
func PrimaryPort(domains []string, fallback int) int {
	for _, raw := range domains {
		if l, e := ParseListen(raw); e == nil && l.Port > 0 {
			return l.Port
		}
	}
	if fallback > 0 {
		return fallback
	}
	return 80
}

func (s Site) Normalized() Site {
	out := s
	listens, e := ParseListens(s.Domains)
	if e == nil {
		raws := make([]string, 0, len(listens))
		for _, l := range listens {
			raws = append(raws, l.Raw)
		}
		out.Domains = raws
	}
	out.Port = PrimaryPort(out.Domains, s.Port)
	clean := make([]ProxyRoute, 0, len(s.Proxies))
	seen := map[string]bool{}
	for _, r := range s.Proxies {
		p := strings.TrimSpace(r.Path)
		u := strings.TrimSpace(r.Upstream)
		if p == "" && u == "" {
			continue
		}
		p = strings.TrimRight(p, "/")
		if p == "" {
			p = "/"
		}
		if seen[p] {
			continue
		}
		seen[p] = true
		clean = append(clean, ProxyRoute{Path: p, Upstream: u})
	}
	out.Proxies = clean
	return out
}

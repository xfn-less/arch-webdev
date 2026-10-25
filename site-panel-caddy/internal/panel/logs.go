package panel

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"site-panel/internal/node"
	"site-panel/internal/remote"
)

var privateKeyBlock = regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----`)

func redactLog(text, password string) string {
	text = privateKeyBlock.ReplaceAllString(text, "[PRIVATE KEY REDACTED]")
	if password != "" {
		text = strings.ReplaceAll(text, password, "[PASSWORD REDACTED]")
	}
	return text
}

// Logs are read-only, bounded snapshots, not arbitrary remote command execution.
// Old tasks have no historical events; their current result is still displayed.
func (a *App) taskLogs(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !node.ValidID(id) {
		fail(w, 400, "无效任务 ID")
		return
	}
	task, e := a.Store.GetTask(id)
	if e != nil {
		fail(w, 404, "任务不存在")
		return
	}
	if selected := r.URL.Query().Get("node_id"); selected != "" && selected != task.NodeID {
		fail(w, 404, "当前节点没有此任务")
		return
	}
	events, e := a.Store.TaskEvents(id)
	if e != nil {
		fail(w, 500, "读取任务记录失败")
		return
	}
	var out strings.Builder
	fmt.Fprintf(&out, "任务 %s\n当前状态: %s · 步骤: %s\n最后更新: %s\n", task.ID, task.Status, task.Step, task.UpdatedAt)
	if task.Error != "" {
		fmt.Fprintf(&out, "结果说明: %s\n", task.Error)
	}
	out.WriteString("\n── 主控执行记录（最近 100 条）──\n")
	if len(events) == 0 {
		out.WriteString("此任务创建于日志记录功能启用之前，仅保留当前结果。\n")
	}
	for _, v := range events {
		fmt.Fprintf(&out, "[%s] %s / %s", v.CreatedAt, v.Status, v.Step)
		if v.Message != "" {
			fmt.Fprintf(&out, " · %s", v.Message)
		}
		out.WriteByte('\n')
	}
	target, targetErr := a.target(task.NodeID)
	remoteError := ""
	if targetErr != nil {
		remoteError = "节点不存在或连接凭据不可用"
	} else if task.Step == "prepare" || task.Status == "queued" {
		out.WriteString("\n任务尚在主控准备中，节点日志可能尚未生成。\n")
	} else {
		unit := "site-panel-task@" + id + ".service"
		if task.SiteID == "" {
			unit = "site-panel-install.service"
			out.WriteString("\n注意：安装服务日志由该节点历次安装共用，不是单次任务独占日志。\n")
		}
		ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
		defer cancel()
		cl, close, err := a.Remote.Connect(ctx, target)
		if err != nil {
			remoteError = err.Error()
		} else {
			defer close()
			data, err := remote.Run(ctx, cl, "journalctl --no-pager --output=short-iso -n 120 -u "+unit)
			if err != nil {
				remoteError = err.Error()
			} else {
				out.WriteString("\n── 节点 journal（最近 120 行，最大 64 KB）──\n")
				out.Write(data)
			}
		}
	}
	// An unavailable SSH connection does not turn the underlying task into failure.
	text := redactLog(out.String(), target.Password)
	if len(text) > 128*1024 {
		text = "[输出过长，仅保留最后 128 KB]\n" + strings.ToValidUTF8(text[len(text)-128*1024:], "�")
	}
	reply(w, 200, map[string]string{"text": text, "remote_error": redactLog(remoteError, target.Password), "observed_at": time.Now().UTC().Format(time.RFC3339)})
}

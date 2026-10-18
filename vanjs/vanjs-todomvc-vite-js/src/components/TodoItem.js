import van from "vanjs-core"

const { div, button, input, label, li } = van.tags

export const TodoItem = props => {
  const { todo } = props
  const editing = van.state(false)
  const draftLabel = van.state(todo.label)

  const saveEdit = () => {
    const label = draftLabel.val.trim()
    if (label) {
      props.onChange({ ...todo, label })
    } else {
      props.onChange({ ...todo, is_delete: true })
    }
    editing.val = false
  }

  const onDone = () => {
    props.onChange({ ...todo, done: !todo.done })
  }

  const onDelete = () => {
    props.onChange({ ...todo, is_delete: true })
  }

  return () => li(
    {
      class: [
        editing.val && "editing",
        todo.done && "completed",
      ].filter(Boolean).join(" "),
    },
    div({ class: "view" },
      input({
        type: "checkbox",
        class: "toggle",
        checked: todo.done,
        onchange: onDone,
      }),
      label({
        ondblclick: () => {
          draftLabel.val = todo.label
          editing.val = true
        },
      }, todo.label),
      button({ class: "destroy", onclick: onDelete })
    ),
    editing.val
      ? input({
        type: "text",
        class: "edit",
        value: draftLabel.val,
        oninput: e => {
          draftLabel.val = e.target.value
        },
        onkeypress: e => {
          if (e.key === "Enter") saveEdit()
        },
        onblur: saveEdit,
      })
      : "",
  )
}

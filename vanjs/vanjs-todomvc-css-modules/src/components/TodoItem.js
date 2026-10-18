import van from "vanjs-core"
import styles from "./TodoItem.module.css"

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
        styles.item,
        editing.val && styles.editing,
        todo.done && styles.completed,
      ].filter(Boolean).join(" "),
    },
    div({ class: styles.view },
      input({
        type: "checkbox",
        class: styles.toggle,
        checked: todo.done,
        onchange: onDone,
      }),
      label({
        class: styles.label,
        ondblclick: () => {
          draftLabel.val = todo.label
          editing.val = true
        },
      }, todo.label),
      button({ class: styles.destroy, onclick: onDelete })
    ),
    editing.val
      ? input({
        type: "text",
        class: `${props.textInputClass} ${styles.edit}`,
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

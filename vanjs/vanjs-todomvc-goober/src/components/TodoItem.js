import { css } from "goober"
import van from "vanjs-core"

const { div, button, input, label, li } = van.tags

const item = css`
  position: relative;
  font-size: 24px;
  border-bottom: 1px solid #ededed;

  &:last-child {
    border-bottom: none;
  }
`

const completed = css`
  label {
    color: #949494;
    text-decoration: line-through;
  }
`

const editing = css`
  border-bottom: none;
  padding: 0;

  &:last-child {
    margin-bottom: -1px;
  }

  .edit {
    display: block;
    width: calc(100% - 43px);
    padding: 12px 16px;
    margin: 0 0 0 43px;
  }

  .view {
    display: none;
  }
`

const toggle = css`
  text-align: center;
  width: 40px;
  height: auto;
  position: absolute;
  top: 0;
  bottom: 0;
  margin: auto 0;
  border: none;
  -webkit-appearance: none;
  appearance: none;
  opacity: 0;

  &:checked + label {
    background-image: url("data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2240%22%20height%3D%2240%22%20viewBox%3D%22-10%20-18%20100%20135%22%3E%3Ccircle%20cx%3D%2250%22%20cy%3D%2250%22%20r%3D%2250%22%20fill%3D%22none%22%20stroke%3D%22%2359A193%22%20stroke-width%3D%223%22%2F%3E%3Cpath%20fill%3D%22%233EA390%22%20d%3D%22M72%2025L42%2071%2027%2056l-4%204%2020%2020%2034-52z%22%2F%3E%3C%2Fsvg%3E");
  }
`

const itemLabel = css`
  overflow-wrap: break-word;
  padding: 15px 15px 15px 60px;
  display: block;
  line-height: 1.2;
  transition: color 0.4s;
  font-weight: 400;
  color: #484848;
  background-image: url("data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%2240%22%20height%3D%2240%22%20viewBox%3D%22-10%20-18%20100%20135%22%3E%3Ccircle%20cx%3D%2250%22%20cy%3D%2250%22%20r%3D%2250%22%20fill%3D%22none%22%20stroke%3D%22%23949494%22%20stroke-width%3D%223%22/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: center left;
`

const destroy = css`
  display: none;
  position: absolute;
  top: 0;
  right: 10px;
  bottom: 0;
  width: 40px;
  height: 40px;
  margin: auto 0;
  font-size: 30px;
  color: #949494;
  transition: color 0.2s ease-out;

  &:hover,
  &:focus {
    color: #c18585;
  }

  &:after {
    content: "×";
    display: block;
    height: 100%;
    line-height: 1.1;
  }
`

const showDestroyOnHover = css`
  &:hover .destroy {
    display: block;
  }
`

const edit = css`
  display: none;
`

export const TodoItem = props => {
  const { todo } = props
  const editingState = van.state(false)
  const draftLabel = van.state(todo.label)

  const saveEdit = () => {
    const label = draftLabel.val.trim()
    if (label) {
      props.onChange({ ...todo, label })
    } else {
      props.onChange({ ...todo, is_delete: true })
    }
    editingState.val = false
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
        item,
        showDestroyOnHover,
        editingState.val && editing,
        todo.done && completed,
      ].filter(Boolean).join(" "),
    },
    div({ class: "view" },
      input({
        type: "checkbox",
        class: `toggle ${toggle}`,
        checked: todo.done,
        onchange: onDone,
      }),
      label({
        class: itemLabel,
        ondblclick: () => {
          draftLabel.val = todo.label
          editingState.val = true
        },
      }, todo.label),
      button({ class: `destroy ${destroy}`, onclick: onDelete })
    ),
    editingState.val
      ? input({
        type: "text",
        class: `edit ${edit} ${props.textInputClass}`,
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

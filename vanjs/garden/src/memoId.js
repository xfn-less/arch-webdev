const pad2 = value => String(value).padStart(2, "0");

const timePrefix = (date = new Date()) => {
  const year = pad2(date.getFullYear() % 100);
  const month = (date.getMonth() + 1).toString(36);
  const day = date.getDate().toString(36);
  const hour = date.getHours().toString(36);
  const minute = pad2(date.getMinutes());

  return `${year}${month}${day}${hour}${minute}`;
};

export const createMemoId = memos => {
  const prefix = timePrefix();
  let sequence = 0;

  while (sequence < 36 * 36) {
    const id = `${prefix}${pad2(sequence.toString(36))}`;
    if (!memos.some(memo => memo.id === id)) return id;
    sequence += 1;
  }

  throw new Error(`Too many memos created in one minute: ${prefix}`);
};

export const formatMemoTime = id => {
  const prefix = id.slice(0, 7);
  const year = 2000 + Number(prefix.slice(0, 2));
  const month = parseInt(prefix[2], 36);
  const day = parseInt(prefix[3], 36);
  const hour = parseInt(prefix[4], 36);
  const minute = prefix.slice(5, 7);

  return `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${minute}`;
};

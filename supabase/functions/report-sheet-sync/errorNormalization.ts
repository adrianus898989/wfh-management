const text = (value: unknown) => String(value ?? "").trim();
const ENGLISH_MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function pick(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = text(row?.[key]);
    if (value) return value;
  }
  return "";
}

function normalizeEmployeeId(value: unknown) {
  return text(value)
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[-–—]+$/, "");
}

function normalizeDate(value: unknown) {
  let dateText = text(value);
  if (!dateText) return "";
  dateText = dateText.split(/[\r\n]+/)[0].trim();

  if (/^\d{5}(\.\d+)?$/.test(dateText)) {
    const date = new Date(
      Date.UTC(1899, 11, 30) + Math.floor(Number(dateText)) * 86_400_000,
    );
    return date.toISOString().slice(0, 10);
  }

  let match = dateText.match(/(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/);
  if (match) {
    return `${match[1]}-${String(+match[2]).padStart(2, "0")}-${
      String(+match[3]).padStart(2, "0")
    }`;
  }

  match = dateText.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
  if (match) {
    let day = +match[1];
    let month = +match[2];
    if (month > 12 && day <= 12) [day, month] = [month, day];
    if (day < 1 || day > 31 || month < 1 || month > 12) return "";
    return `${match[3]}-${String(month).padStart(2, "0")}-${
      String(day).padStart(2, "0")
    }`;
  }

  match = dateText.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i);
  if (match) {
    const day = +match[1];
    const month = ENGLISH_MONTHS[match[2].toLowerCase()];
    if (day >= 1 && day <= 31 && month) {
      return `${match[3]}-${String(month).padStart(2, "0")}-${
        String(day).padStart(2, "0")
      }`;
    }
  }

  const date = new Date(dateText);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function hash32(input: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Converts either OpenSheet objects or position-mapped private-sheet objects
 * into the canonical report error row shape.
 *
 * The finance workbook currently labels its first employee-ID column `a`.
 * Keep that exact alias last so a proper ID header always wins if both exist.
 */
export function normalizeEmployeeErrors(
  rawErrors: Record<string, unknown>[],
  sourceName: string,
) {
  return rawErrors.map((row, index) => {
    const employeeId = normalizeEmployeeId(
      pick(row, ["员工ID", "員工ID", "ID", "a"]),
    );
    const memberOrder = pick(row, ["会员/id /订单号", "會員/id /訂單號"]);
    const errorNote = pick(row, ["错误备注", "錯誤備註"]);
    const errorType = pick(row, ["错误类型", "錯誤類型"]);
    const qcPerson = pick(row, ["质检人", "質檢人"]);
    const qcDate = normalizeDate(pick(row, ["质检时间", "質檢時間"]));
    const recordKey = `${employeeId}|${qcDate}|${
      hash32([memberOrder, errorType, qcPerson, errorNote].join("|"))
    }`;

    return {
      source_name: sourceName,
      record_key: recordKey,
      source_row: index + 2,
      employee_id: employeeId,
      member_order: memberOrder,
      amount: pick(row, ["金额", "金額"]),
      error_note: errorNote,
      correct_action: pick(row, ["正确操作方式", "正確操作方式"]),
      error_type: errorType,
      score: pick(row, ["扣分"]),
      qc_person: qcPerson,
      qc_date: qcDate,
      leader_review: pick(row, ["小组长复审", "小組長複審"]),
      qc_result: pick(row, ["质检人对错", "质检人对/错", "質檢人對錯"]),
      review_date: normalizeDate(pick(row, ["复检时间", "複檢時間"])),
    };
  }).filter((row) =>
    row.employee_id && (
      row.qc_date || row.review_date || row.error_type || row.error_note
    )
  );
}

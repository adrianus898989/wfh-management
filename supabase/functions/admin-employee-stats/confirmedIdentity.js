const valueText = (value) => String(value ?? "").trim();

export const confirmedEmployeeIdentityKey = (value) => (
  valueText(value).toUpperCase().replace(/[^A-Z0-9]/g, "")
);

export const confirmedEmployeeNameKey = (value) => (
  valueText(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "")
);

export function uniqueConfirmedEmployeeNos(values) {
  const byIdentityKey = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const rawEmployeeNo = valueText(value).toUpperCase();
    const identityKey = confirmedEmployeeIdentityKey(rawEmployeeNo);
    if (identityKey && !byIdentityKey.has(identityKey)) {
      byIdentityKey.set(identityKey, rawEmployeeNo);
    }
  }
  return [...byIdentityKey.values()];
}

function resolutionIndex(rows) {
  const byIdentityKey = new Map();
  const inconsistentKeys = new Set();

  for (const row of Array.isArray(rows) ? rows : []) {
    const identityKey = valueText(row?.raw_identity_key)
      || confirmedEmployeeIdentityKey(row?.raw_employee_no);
    if (!identityKey) continue;

    const normalized = {
      rawEmployeeNo: valueText(row?.raw_employee_no).toUpperCase(),
      identityKey,
      employeeId: valueText(row?.employee_id),
      canonicalEmployeeNo: valueText(row?.canonical_employee_no).toUpperCase(),
      confirmedFullName: valueText(row?.confirmed_full_name),
      isConfirmedAlias: row?.is_confirmed_alias === true,
    };
    const previous = byIdentityKey.get(identityKey);
    if (previous && (
      previous.employeeId !== normalized.employeeId
      || previous.canonicalEmployeeNo !== normalized.canonicalEmployeeNo
      || previous.confirmedFullName !== normalized.confirmedFullName
      || previous.isConfirmedAlias !== normalized.isConfirmedAlias
    )) {
      inconsistentKeys.add(identityKey);
    } else if (!previous) {
      byIdentityKey.set(identityKey, normalized);
    }
  }

  return { byIdentityKey, inconsistentKeys };
}

export function canonicalizeConfirmedPresentEmployeeNos(rawEmployeeNos, rows) {
  const requested = uniqueConfirmedEmployeeNos(rawEmployeeNos);
  const { byIdentityKey, inconsistentKeys } = resolutionIndex(rows);
  const presentEmployeeNos = new Set();
  const conflicts = [];

  for (const rawEmployeeNo of requested) {
    const identityKey = confirmedEmployeeIdentityKey(rawEmployeeNo);
    const resolution = byIdentityKey.get(identityKey);

    if (inconsistentKeys.has(identityKey)) {
      conflicts.push({ rawEmployeeNo, reason: "inconsistent_resolution" });
      continue;
    }
    if (!resolution) {
      conflicts.push({ rawEmployeeNo, reason: "missing_resolution" });
      continue;
    }
    if (resolution.employeeId && resolution.canonicalEmployeeNo) {
      presentEmployeeNos.add(resolution.canonicalEmployeeNo);
      continue;
    }
    if (resolution.isConfirmedAlias) {
      conflicts.push({ rawEmployeeNo, reason: "confirmed_alias_conflict" });
      continue;
    }

    // Unknown, non-reserved IDs retain the previous exact-presence behavior.
    presentEmployeeNos.add(rawEmployeeNo);
  }

  return { presentEmployeeNos, conflicts };
}

export function resolveConfirmedResignationItems(items, rows) {
  const { byIdentityKey, inconsistentKeys } = resolutionIndex(rows);
  const resolved = [];
  const missing = [];
  const conflicts = [];

  for (const item of Array.isArray(items) ? items : []) {
    const sourceEmployeeNo = valueText(item?.employee_no).toUpperCase();
    const identityKey = confirmedEmployeeIdentityKey(sourceEmployeeNo);
    const resolution = byIdentityKey.get(identityKey);

    if (!identityKey || !resolution) {
      missing.push({ item, reason: "employee_not_found" });
      continue;
    }
    if (inconsistentKeys.has(identityKey)) {
      conflicts.push({ item, reason: "inconsistent_resolution" });
      continue;
    }
    if (!resolution.employeeId || !resolution.canonicalEmployeeNo) {
      if (resolution.isConfirmedAlias) {
        conflicts.push({ item, reason: "confirmed_alias_conflict" });
      } else {
        missing.push({ item, reason: "employee_not_found" });
      }
      continue;
    }

    if (resolution.isConfirmedAlias) {
      const sourceNameKey = confirmedEmployeeNameKey(item?.employee_name);
      const confirmedNameKey = confirmedEmployeeNameKey(
        resolution.confirmedFullName,
      );
      if (sourceNameKey && (
        !confirmedNameKey || sourceNameKey !== confirmedNameKey
      )) {
        conflicts.push({ item, reason: "confirmed_alias_name_mismatch" });
        continue;
      }
    }

    resolved.push({
      item,
      employeeId: resolution.employeeId,
      canonicalEmployeeNo: resolution.canonicalEmployeeNo,
      sourceEmployeeNo,
      isConfirmedAlias: resolution.isConfirmedAlias,
    });
  }

  return { resolved, missing, conflicts };
}

export function prepareConfirmedResignationItems(items) {
  const datesByEmployeeId = new Map();
  const firstByEmployeeDate = new Map();

  for (const resolvedItem of Array.isArray(items) ? items : []) {
    const employeeId = valueText(resolvedItem?.employeeId);
    const resignDate = valueText(resolvedItem?.item?.resign_date).slice(0, 10);
    if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(resignDate)) continue;

    if (!datesByEmployeeId.has(employeeId)) {
      datesByEmployeeId.set(employeeId, new Set());
    }
    datesByEmployeeId.get(employeeId).add(resignDate);

    const key = `${employeeId}|${resignDate}`;
    if (!firstByEmployeeDate.has(key)) firstByEmployeeDate.set(key, resolvedItem);
  }

  const conflicts = [];
  for (const [employeeId, resignDates] of datesByEmployeeId) {
    if (resignDates.size <= 1) continue;
    const related = (Array.isArray(items) ? items : []).filter(
      (item) => valueText(item?.employeeId) === employeeId,
    );
    conflicts.push({
      employeeId,
      canonicalEmployeeNo: valueText(related[0]?.canonicalEmployeeNo).toUpperCase(),
      resignDates: [...resignDates].sort(),
      sourceEmployeeNos: [...new Set(related.map(
        (item) => valueText(item?.sourceEmployeeNo).toUpperCase(),
      ).filter(Boolean))].sort(),
    });
  }

  return {
    items: conflicts.length ? [] : [...firstByEmployeeDate.values()],
    conflicts,
  };
}

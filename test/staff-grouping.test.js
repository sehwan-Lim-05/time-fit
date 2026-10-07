import test from "node:test";
import assert from "node:assert/strict";
import { groupStaffByType } from "../src/lib/staffGrouping.js";

test("직원은 등록 순서를 유지하며 부서별로 묶인다", () => {
  const groups = groupStaffByType([
    { id: "a", team: "운영팀" },
    { id: "b", team: "주방팀" },
    { id: "c", team: "운영팀" },
    { id: "d", team: "" },
  ]);
  assert.deepEqual(
    groups.map((group) => [group.type, group.staff.map((item) => item.id)]),
    [
      ["운영팀", ["a", "c"]],
      ["주방팀", ["b"]],
      ["미분류", ["d"]],
    ],
  );
});

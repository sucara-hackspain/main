import { test } from "node:test";
import assert from "node:assert/strict";
import { assertEngineRecords, unitStatus, type UnitFrame } from "../src/ui/engineTrace";

const frame = {
  units: [],
  scenes: [],
  incidents: [],
  closedEdges: [],
};

test("the engine's run format is accepted and the previous one rejected with a way forward", () => {
  assert.doesNotThrow(() =>
    assertEngineRecords([{ tick: 0, frame, events: [], actions: [] }]),
  );
  assert.throws(
    () =>
      assertEngineRecords([
        { tick: 0, frame: { ambulances: [], patients: [] }, events: [], actions: [] },
      ]),
    /formato anterior de ambulancias y pacientes.*npm run data:local/,
  );
  assert.throws(() => assertEngineRecords(null), /Formato de registros/);
  assert.throws(() => assertEngineRecords([{ tick: 0, frame: { units: [] } }]), /Formato de registros/);
});

test("an idle unit is not claimed to be available: the frame has no busy deadline", () => {
  const idle = { id: "B1", kind: "fire", mission: "idle", victimId: null, incidentId: null, broken: false, stranded: false } as UnitFrame;
  assert.equal(unitStatus(idle), "Sin misión");
  assert.equal(unitStatus({ ...idle, stranded: true, incidentId: "C4" }), "Sin ruta conocida hacia C4");
  assert.equal(unitStatus({ ...idle, victimId: "V2" }), "Víctima a bordo, sin destino");
});

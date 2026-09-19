# Recorded inputs

`legacy-run.json` contains snapshots from a local greedy simulation (seed 2)
recorded with the ambulance/patient trace contract supported by Control Center.
It retains ticks 0–31, 80 and 119, including terminal patient states and hospital
occupancy. It contains no external model output or real patient data.

The browser tests serve these records through the same incremental API contract
as the application. They use the repository's Valencia graph. They deliberately
do not generate fresh engine traces: the engine now writes units, scenes and
incidents, whose UI migration is a separate task. Unsupported new-format records
have their own explicit-error regression test.

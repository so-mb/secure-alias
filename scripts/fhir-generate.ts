import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

type Gender = "female" | "male" | "other" | "unknown";
type Names = {
  givenNames: { female: string[]; male: string[] };
  familyNames: string[];
};
type Coding = { system: string; code: string; display: string };
type Patient = {
  resourceType: "Patient";
  id: string;
  identifier: { system: string; value: string }[];
  name: { given: string[]; family: string }[];
  gender: Gender;
  birthDate: string;
  address: { postalCode: string; country: "DE" }[];
};
type Observation = {
  resourceType: "Observation";
  id: string;
  status: "final";
  category: { coding: Coding[] }[];
  code: { coding: Coding[] };
  subject: { reference: string };
  effectiveDateTime: string;
  valueQuantity: {
    value: number;
    unit: string;
    system: string;
    code: string;
  };
};
type Entry = { fullUrl: string; resource: Patient | Observation };

const patientCount = 100;
const baseUrl = "https://secure-alias.example/fhir";
const identifierSystem = "https://secure-alias.example/patient-id";
const postalCodes = ["01067", "10115", "20095", "53113", "80331"];

async function main() {
  const { values } = parseArgs({
    options: {
      seed: { type: "string" },
      "reference-date": { type: "string" },
      output: { type: "string" },
    },
  });
  const seed = values.seed ?? "42";
  const referenceDate = values["reference-date"] ?? "2026-11-01";
  const output = resolve(values.output ?? ".local/data/synthetic-fhir.json");
  assert(seed.trim().length > 0, "Seed must not be empty");
  assert(
    /^\d{4}-\d{2}-\d{2}$/.test(referenceDate),
    "Use YYYY-MM-DD for the reference date",
  );
  const reference = new Date(`${referenceDate}T09:00:00Z`);
  assert(
    Number.isFinite(reference.getTime()) &&
      reference.getUTCFullYear() >= 1900 &&
      reference.toISOString().slice(0, 10) === referenceDate,
    "Reference date must be a real calendar date in or after 1900",
  );
  const firstMeasurement = new Date(reference.getTime() - 7 * 86_400_000);

  const nameFile = await readFile(
    new URL("../data/german-names.json", import.meta.url),
    "utf8",
  );
  const names = JSON.parse(nameFile) as Names;
  for (const pool of [
    names?.givenNames?.female,
    names?.givenNames?.male,
    names?.familyNames,
  ]) {
    assert(
      Array.isArray(pool) &&
        pool.length > 0 &&
        pool.every(
          (name) => typeof name === "string" && name.trim().length > 0,
        ),
      "Each name pool must be a nonempty array of names",
    );
    assert.equal(
      new Set(pool).size,
      pool.length,
      "Name pools must not contain duplicates",
    );
  }

  let counter = 0;
  function randomInt(min: number, max: number) {
    const bytes = createHash("sha256").update(`${seed}:${counter++}`).digest();
    return min + (bytes.readUInt32BE(0) % (max - min + 1));
  }
  function pick<T>(pool: T[]): T {
    return pool[randomInt(0, pool.length - 1)];
  }

  const genders: Gender[] = Array.from({ length: patientCount }, (_, index) =>
    index === 98
      ? "other"
      : index === 99
        ? "unknown"
        : index % 2 === 0
          ? "female"
          : "male",
  );
  for (let index = genders.length - 1; index > 0; index--) {
    const other = randomInt(0, index);
    [genders[index], genders[other]] = [genders[other], genders[index]];
  }
  const allGivenNames = [...names.givenNames.female, ...names.givenNames.male];
  const entry: Entry[] = [];

  for (let index = 0; index < patientCount; index++) {
    const number = String(index + 1).padStart(3, "0");
    const id = `patient-${number}`;
    const gender = genders[index];
    const givenPool =
      gender === "female" || gender === "male"
        ? names.givenNames[gender]
        : allGivenNames;
    const year = randomInt(
      reference.getUTCFullYear() - 65,
      firstMeasurement.getUTCFullYear() - 19,
    );
    const month = randomInt(0, 11);
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const birthDate = new Date(Date.UTC(year, month, randomInt(1, lastDay)))
      .toISOString()
      .slice(0, 10);
    const patient: Patient = {
      resourceType: "Patient",
      id,
      identifier: [
        {
          system: identifierSystem,
          value: `SA-${String(index + 1).padStart(4, "0")}`,
        },
      ],
      name: [{ given: [pick(givenPool)], family: pick(names.familyNames) }],
      gender,
      birthDate,
      address: [{ postalCode: pick(postalCodes), country: "DE" }],
    };
    entry.push({ fullUrl: `${baseUrl}/Patient/${id}`, resource: patient });

    for (const [visit, date] of [firstMeasurement, reference].entries()) {
      const observation: Observation = {
        resourceType: "Observation",
        id: `observation-${number}-${visit + 1}`,
        status: "final",
        category: [
          {
            coding: [
              {
                system:
                  "http://terminology.hl7.org/CodeSystem/observation-category",
                code: "vital-signs",
                display: "Vital Signs",
              },
            ],
          },
        ],
        code: {
          coding: [
            {
              system: "http://loinc.org",
              code: "8867-4",
              display: "Heart rate",
            },
          ],
        },
        subject: { reference: `Patient/${id}` },
        effectiveDateTime: date.toISOString(),
        valueQuantity: {
          value: randomInt(55, 110),
          unit: "beats/minute",
          system: "http://unitsofmeasure.org",
          code: "/min",
        },
      };
      entry.push({
        fullUrl: `${baseUrl}/Observation/${observation.id}`,
        resource: observation,
      });
    }
  }

  const json =
    JSON.stringify(
      { resourceType: "Bundle", type: "collection", entry },
      null,
      2,
    ) + "\n";
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, json, "utf8");
  console.log(
    JSON.stringify(
      {
        status: "PASS",
        output,
        seed,
        referenceDate,
        patients: patientCount,
        observations: patientCount * 2,
        sha256: createHash("sha256").update(json).digest("hex"),
        nameListSha256: createHash("sha256").update(nameFile).digest("hex"),
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      status: "FAIL",
      message:
        error instanceof Error ? error.message : "FHIR generation failed",
    }),
  );
  process.exitCode = 1;
});

import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createClientAsync, type Client } from "soap";

// Synthetic fixtures
const ids = ["SYNTHETIC-SA-001", "SYNTHETIC-SA-002"];
const domains = [
  { name: "secure_alias_smoke_a", prefix: "SAA_" },
  { name: "secure_alias_smoke_b", prefix: "SAB_" },
];

const resultsDir = process.env.GPAS_SMOKE_RESULTS ?? ".local/smoke";
const baselinePath = join(resultsDir, "smoke-before.json");

const mode = process.argv[2] ?? "before";
const base = new URL(process.env.GPAS_BASE_URL ?? "http://127.0.0.1:18080");

assert(
  ["before", "after", "probe"].includes(mode),
  "Use before, after, or probe",
);

assert(
  base.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(base.hostname),
  "This smoke script is restricted to the local fictional-data lab",
);
assert(
  !base.username &&
    !base.password &&
    base.pathname === "/" &&
    !base.search &&
    !base.hash,
  "GPAS_BASE_URL must be a bare loopback origin",
);

const timeout = 10_000;

type Mapping = { domain: string; sourceId: string; pseudonym: string };
type Baseline = { mappings: Mapping[]; origin: string; fixture: string[] };

async function client(service: string): Promise<Client> {
  const endpoint = `${base.origin}/gpas/${service}`;

  return createClientAsync(`${endpoint}?wsdl`, {
    endpoint,
    disableCache: true,
    wsdl_options: { timeout, proxy: false },
  });
}

async function call(c: Client, operation: string, args: object) {
  assert.equal(
    typeof c[`${operation}Async`],
    "function",
    `WSDL lacks ${operation}`,
  );

  const [result] = await c[`${operation}Async`](args, {
    timeout,
    proxy: false,
  });

  // addDomain returns no data
  if (operation === "addDomain") return {};

  assert(result && typeof result === "object", `Invalid ${operation} response`);
  return result;
}

async function main() {
  const health = await fetch(`${base.origin}/gpas-rest/health/state`, {
    signal: AbortSignal.timeout(timeout),
  });
  assert.equal(health.status, 200, "gPAS health endpoint must return 200");

  const service = (await health.json()) as {
    status?: string;
    version?: string;
  };
  assert.equal(service.status, "ok", "gPAS health body must report ok");
  assert.equal(service.version, "2026.1.1", "Unexpected gPAS release");

  const [domainClient, psnClient] = await Promise.all([
    client("DomainService"),
    client("gpasService"),
  ]);

  if (mode === "probe") {
    console.log(
      JSON.stringify({
        status: "PASS",
        mode,
        origin: base.origin,
        health: 200,
        serviceVersion: service.version,
        wsdl: true,
      }),
    );
    return;
  }

  let baseline: Baseline | undefined;
  if (mode === "before") {
    const exists = await access(baselinePath).then(
      () => true,
      () => false,
    );

    assert(
      !exists,
      "Baseline already exists; use after to verify it. Do not reset evidence or volumes.",
    );
  } else {
    baseline = JSON.parse(await readFile(baselinePath, "utf8"));

    assert.equal(
      baseline?.origin,
      base.origin,
      "Baseline belongs to another service origin",
    );
    assert.deepEqual(baseline?.fixture, ids, "Baseline fixture changed");
    assert.equal(baseline?.mappings.length, ids.length * domains.length);
  }

  const listed = await call(domainClient, "listDomains", {});
  const existing = listed.return?.domainList ?? [];
  assert(Array.isArray(existing), "Invalid listDomains response");

  const mappings: Mapping[] = [];

  for (const domain of domains) {
    if (!existing.some((d: { name: string }) => d.name === domain.name)) {
      assert.equal(mode, "before", "Domain disappeared after restart");

      await call(domainClient, "addDomain", {
        domainDTO: {
          name: domain.name,
          label: `Secure Alias fictional smoke ${domain.name}`,
          alphabet: "org.emau.icmvc.ganimed.ttp.psn.alphabets.Hex",
          checkDigitClass:
            "org.emau.icmvc.ganimed.ttp.psn.generator.NoCheckDigits",
          config: {
            forceCache: "OFF",
            includePrefixInCheckDigitCalculation: false,
            includeSuffixInCheckDigitCalculation: false,
            maxDetectedErrors: 1,
            multiPsnDomain: false,
            psnLength: 8,
            psnPrefix: domain.prefix,
            psnSuffix: "",
            psnsDeletable: false,
            sendNotificationsWeb: false,
            useLastCharAsDelimiterAfterXChars: 0,
            validateValuesViaParents: "OFF",
          },
          comment: "Entirely fictional Secure Alias smoke fixture",
        },
      });
    }

    const { domain: actual } = await call(domainClient, "getDomain", {
      domainName: domain.name,
    });
    assert.equal(actual?.config?.multiPsnDomain, false);
    assert.equal(actual?.config?.psnPrefix, domain.prefix);
    assert.equal(actual?.config?.psnLength, 8);

    for (const sourceId of ids) {
      // Lookup only after restart to detect lost mappings
      const operation =
        mode === "before" ? "getOrCreatePseudonymFor" : "getPseudonymFor";

      const { psn } = await call(psnClient, operation, {
        value: sourceId,
        domainName: domain.name,
      });
      assert.equal(typeof psn, "string", "Missing pseudonym");
      assert(
        psn.startsWith(domain.prefix) &&
          /^[0-9A-F]{8}$/.test(psn.slice(domain.prefix.length)),
        "Pseudonym does not match configured domain format",
      );

      const repeated = await call(psnClient, operation, {
        value: sourceId,
        domainName: domain.name,
      });
      assert.equal(repeated.psn, psn, "Repeat request changed the mapping");

      const reverse = await call(psnClient, "getValueFor", {
        psn,
        domainName: domain.name,
      });
      assert.equal(
        reverse.value,
        sourceId,
        "Reverse lookup associated the wrong source",
      );

      if (baseline) {
        assert.equal(
          baseline.mappings.find(
            (m) => m.domain === domain.name && m.sourceId === sourceId,
          )?.pseudonym,
          psn,
          "Persisted mapping differs from baseline",
        );
      }

      mappings.push({ domain: domain.name, sourceId, pseudonym: psn });
    }

    assert.equal(
      new Set(
        mappings
          .filter((m) => m.domain === domain.name)
          .map((m) => m.pseudonym),
      ).size,
      ids.length,
    );
  }

  assert.equal(new Set(mappings.map((m) => m.pseudonym)).size, mappings.length);

  const report = {
    status: "PASS",
    mode,
    executedAt: new Date().toISOString(),
    node: process.version,
    origin: base.origin,
    fixture: ids,
    domains,
    mappings,
    checks: [
      "health-200",
      "actual-WSDL-client",
      "single-PSN-domains",
      "repeat-request-stability",
      "distinct-fixture-pseudonyms",
      "reverse-lookup",
      "domain-prefixes",
      ...(baseline
        ? ["lookup-only-matches-pre-restart-baseline"]
        : ["get-or-create"]),
    ],
    contractSha256: Object.fromEntries(
      [
        ["DomainService", domainClient],
        ["gpasService", psnClient],
      ].map(([name, c]) => [
        name,
        createHash("sha256")
          .update((c as Client).wsdl.toXML())
          .digest("hex"),
      ]),
    ),
  };

  await mkdir(resultsDir, { recursive: true });
  const path =
    mode === "before" ? baselinePath : join(resultsDir, "smoke-after.json");
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  // Avoid logging SOAP payloads, credentials or identifiers
  const message =
    error instanceof Error ? error.message : "Unknown smoke failure";
  console.error(JSON.stringify({ status: "FAIL", mode, message }));
  process.exitCode = 1;
});

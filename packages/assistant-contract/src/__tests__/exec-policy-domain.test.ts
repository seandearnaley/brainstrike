/**
 * The code-execution policy domain grammar, read the way the model reads it.
 *
 * Every rule is a `Schema.makeFilter` carrying its own message, and those
 * messages are the whole value of the filters: a bare `*` and a malformed
 * hostname are BOTH rejected by the generic `DOMAIN_PATTERN` rule as well, so
 * the specific rules exist to say WHY. Nothing else in the suite asserts the
 * text, which means a conversion could have replaced any of them with
 * `Schema.isPattern` and lost the explanation without a single test noticing.
 *
 * Read through `validateToolInputValue` rather than the schema's own decoder:
 * these messages travel to the model as a failed `run_python` call, and that
 * accessor is the path they travel.
 */
import { describe, expect, it } from 'vitest';
import { MAX_POLICY_DOMAIN_LENGTH } from '../native-tools/schemas/exec-policy-domain.js';
import { RunPythonInputSchema } from '../native-tools/schemas/schemas-execution.js';
import {
  toToolInputJsonSchema,
  validateToolInputValue,
} from '../native-tools/schemas/tool-input-schema.js';

/** A hostname of exactly `length` characters, in legal 61-character labels. */
function hostnameOfLength(length: number): string {
  const labels: string[] = [];
  let remaining = length;
  while (remaining > 62) {
    labels.push('a'.repeat(61));
    remaining -= 62; // the label plus its separating dot
  }
  labels.push('a'.repeat(remaining));
  return labels.join('.');
}

/** Every issue message reported for a single `allowedDomains` entry. */
function domainIssues(domain: string): readonly string[] {
  const result = validateToolInputValue(RunPythonInputSchema, {
    allowedDomains: [domain],
    code: 'print(1)',
  });
  if (result.success) {
    return [];
  }
  return result.issues.map((issue) => issue.message);
}

describe('run_python allowedDomains grammar', () => {
  it.each([['pypi.org'], ['*.example.com'], ['api.github.com']])('accepts %j', (domain) => {
    expect(domainIssues(domain)).toEqual([]);
  });

  it('bounds an entry at MAX_POLICY_DOMAIN_LENGTH exactly', () => {
    // The advertised `maxLength` and the enforced one have to be the same
    // number — `isMaxLength`, not `isMaxCodePoints`, is what keeps them equal
    // to the zod bound this replaced.
    expect(hostnameOfLength(MAX_POLICY_DOMAIN_LENGTH)).toHaveLength(MAX_POLICY_DOMAIN_LENGTH);
    expect(domainIssues(hostnameOfLength(MAX_POLICY_DOMAIN_LENGTH))).toEqual([]);
    expect(domainIssues(hostnameOfLength(MAX_POLICY_DOMAIN_LENGTH + 1))).not.toEqual([]);
    const advertised = toToolInputJsonSchema(RunPythonInputSchema, 'draft-07') as {
      properties: { allowedDomains: { items: { maxLength: number; minLength: number } } };
    };
    expect(advertised.properties.allowedDomains.items).toMatchObject({
      maxLength: MAX_POLICY_DOMAIN_LENGTH,
      minLength: 1,
    });
  });

  it('names a bare "*" as inexpressible rather than merely malformed', () => {
    // The invariant: an empty allowedDomains list means "no network", so a
    // single wildcard entry would invert it. `DOMAIN_PATTERN` also rejects
    // `*`, so without this message the model would be told its domain is
    // malformed and would reasonably retry with another wildcard spelling.
    expect(domainIssues('*')).toContain(
      'a bare "*" wildcard is not expressible; list explicit domains'
    );
  });

  it.each([['*.com'], ['*.io']])('rejects the over-broad wildcard %j by depth', (domain) => {
    // These DO match `DOMAIN_PATTERN`, so this rule is the only thing standing
    // between the model and a whole-TLD grant.
    expect(domainIssues(domain)).toEqual([
      'a wildcard must name a parent domain of at least two labels (e.g. "*.example.com", not "*.com")',
    ]);
  });

  it('reports a blank entry as blank, not as a malformed hostname', () => {
    expect(domainIssues('   ')).toContain('must not be blank');
  });

  it.each([['not a domain!'], ['http://example.com'], ['exa mple.com'], ['*.*']])(
    'rejects %j as not hostname-shaped',
    (domain) => {
      expect(domainIssues(domain)).toContain('must be a hostname or a "*.example.com" wildcard');
    }
  );

  it.each([['127.0.0.1'], ['192.168.1.10'], ['169.254.169.254']])(
    'refuses the IP literal %j with the public-domain message',
    (domain) => {
      // run_python's own rule on top of the shared grammar: the escalation card
      // would present an IP literal as "the internet" while the grant is the
      // user's own machine or network.
      expect(domainIssues(domain)).toContain('IP literals are not allowed; name a public domain');
    }
  );

  it.each([['localhost'], ['db.localhost'], ['printer.local'], ['*.local']])(
    'refuses the local address %j with the public-domain message',
    (domain) => {
      expect(domainIssues(domain)).toContain(
        'localhost and .local addresses are not allowed; name a public domain'
      );
    }
  );

  it('accepts an explicit empty list as the offline request', () => {
    // Not a degenerate case: OpenAI's strict function-calling emits every
    // declared property, so `[]` is how an offline call arrives.
    expect(
      validateToolInputValue(RunPythonInputSchema, { allowedDomains: [], code: 'print(1)' })
    ).toEqual({ success: true, value: { allowedDomains: [], code: 'print(1)' } });
  });
});

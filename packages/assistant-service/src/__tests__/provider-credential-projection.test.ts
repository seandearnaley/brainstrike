/**
 * Credential → factory auth-input projection (BST-1352, extended by BST-1350):
 * the ONE credential-type narrow in this package. Bedrock (registry authType
 * 'aws') projects onto the `aws` auth kind — stored bearer credentials carry
 * their own region, env bearer keys borrow AWS_REGION — while every other
 * provider keeps the api_key projection exactly as before.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  providerAuthInputFromCredential,
  UnsupportedCredentialTypeError,
} from '../provider-credential-projection.js';

describe('providerAuthInputFromCredential (BST-1350 aws mapping)', () => {
  it('keeps the api_key projection for non-aws providers', () => {
    expect(
      providerAuthInputFromCredential('openai', { key: 'k', source: 'stored', type: 'api_key' })
    ).toEqual({ apiKey: 'k', kind: 'api_key' });
  });

  it('passes undefined through', () => {
    expect(providerAuthInputFromCredential('openai', undefined)).toBeUndefined();
  });

  it('projects a stored aws bearer credential to the aws kind with ITS region', () => {
    expect(
      providerAuthInputFromCredential('bedrock', {
        bearerKey: 'stored-bearer',
        mode: 'bearer',
        region: 'eu-west-1',
        source: 'stored',
        type: 'aws',
      })
    ).toEqual({ apiKey: 'stored-bearer', kind: 'aws', region: 'eu-west-1' });
  });

  it('projects an env bearer key on an aws provider with the AWS_REGION env region', () => {
    expect(
      providerAuthInputFromCredential(
        'bedrock',
        { key: 'env-bearer', source: 'env', type: 'api_key' },
        { env: { AWS_REGION: 'us-east-1' } }
      )
    ).toEqual({ apiKey: 'env-bearer', kind: 'aws', region: 'us-east-1' });
  });

  it('projects an empty region when AWS_REGION is unset (factory validator owns the reject)', () => {
    // The projection's only visible-error channel is SecretReadError-shaped
    // (secret failures); a missing region is a CONFIG failure, so it rides to
    // the one factory validator, which rejects with the actionable
    // "Configure an AWS region for Bedrock in Settings" typed error.
    expect(
      providerAuthInputFromCredential(
        'bedrock',
        { key: 'env-bearer', source: 'env', type: 'api_key' },
        { env: {} }
      )
    ).toEqual({ apiKey: 'env-bearer', kind: 'aws', region: '' });
  });

  it('trims a whitespace-only AWS_REGION to the empty region', () => {
    expect(
      providerAuthInputFromCredential(
        'bedrock',
        { key: 'env-bearer', source: 'env', type: 'api_key' },
        { env: { AWS_REGION: '   ' } }
      )
    ).toEqual({ apiKey: 'env-bearer', kind: 'aws', region: '' });
  });

  // BST-1353 — the chain is an INJECTED capability. These two tests are the
  // structural proof that Hosted Web can never resolve a profile chain: the
  // SAME credential projects on a host that supplies the capability and
  // rejects on one that does not. Web supplies none.
  it('rejects a profile_chain credential when the host supplies NO chain capability (web)', () => {
    let thrown: unknown;
    try {
      providerAuthInputFromCredential('bedrock', {
        mode: 'profile_chain',
        profile: 'work',
        region: 'us-east-1',
        source: 'stored',
        type: 'aws',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedCredentialTypeError);
    const shaped = thrown as UnsupportedCredentialTypeError;
    expect(shaped.name).toBe('SecretReadError');
    expect(shaped.code).toBe('credential_type_unsupported');
    expect(shaped.provider).toBe('bedrock');
    expect(shaped.message).toContain('desktop');
    // The credential's fields never leak through the message.
    expect(shaped.message).not.toContain('work');
  });

  it('projects a profile_chain credential through the INJECTED chain capability (desktop)', () => {
    const resolver = async () => ({ accessKeyId: 'AKIA', secretAccessKey: 'sec' });
    const awsCredentialChain = vi.fn(() => resolver);

    const auth = providerAuthInputFromCredential(
      'bedrock',
      {
        mode: 'profile_chain',
        profile: 'work',
        region: 'us-east-1',
        source: 'stored',
        type: 'aws',
      },
      { awsCredentialChain }
    );

    // The stored profile is handed to the chain builder verbatim.
    expect(awsCredentialChain).toHaveBeenCalledWith('work');
    expect(auth).toEqual({ credentialProvider: resolver, kind: 'aws', region: 'us-east-1' });
    // A chain carries NO bearer — the two forms are mutually exclusive.
    expect(auth?.apiKey).toBeUndefined();
  });

  it('passes an ABSENT profile through as undefined (the chain default)', () => {
    const awsCredentialChain = vi.fn(() => async () => ({
      accessKeyId: 'AKIA',
      secretAccessKey: 'sec',
    }));

    providerAuthInputFromCredential(
      'bedrock',
      { mode: 'profile_chain', region: 'eu-west-1', source: 'stored', type: 'aws' },
      { awsCredentialChain }
    );

    expect(awsCredentialChain).toHaveBeenCalledWith(undefined);
  });

  it('rejects an aws credential stored for a non-aws provider', () => {
    let thrown: unknown;
    try {
      providerAuthInputFromCredential('openai', {
        bearerKey: 'stored-bearer',
        mode: 'bearer',
        region: 'us-east-1',
        source: 'stored',
        type: 'aws',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedCredentialTypeError);
    expect((thrown as UnsupportedCredentialTypeError).provider).toBe('openai');
    expect((thrown as UnsupportedCredentialTypeError).message).not.toContain('stored-bearer');
  });

  it('still rejects oauth credentials typed', () => {
    expect(() =>
      providerAuthInputFromCredential('anthropic', {
        access: 'a',
        expires: 1,
        refresh: 'r',
        source: 'stored',
        type: 'oauth',
      })
    ).toThrow(UnsupportedCredentialTypeError);
  });
});

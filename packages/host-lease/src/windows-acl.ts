import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeThrowingDecoder, runWithTimeout } from '@brainstrike/effect-kit';
import { Schema } from 'effect';

export type AclKind = 'directory' | 'file';
export type AclAction = 'set' | 'verify';
export type AclRunner = (environment: NodeJS.ProcessEnv) => Promise<string>;
const AclSchema = Schema.Struct({
  currentSid: Schema.String,
  ownerSid: Schema.String,
  protected: Schema.Boolean,
  rules: Schema.Array(
    Schema.Struct({
      inheritance: Schema.Int,
      isInherited: Schema.Boolean,
      propagation: Schema.Int,
      rights: Schema.Int,
      sid: Schema.String,
      type: Schema.String,
    })
  ),
});
const decodeAcl = makeThrowingDecoder(AclSchema, { onExcessProperty: 'error' });
// The path travels only through the environment, never PowerShell source.
const command = `
$ErrorActionPreference = 'Stop'
$path = $env:BRAINSTRIKE_LEASE_ACL_PATH
$kind = $env:BRAINSTRIKE_LEASE_ACL_KIND
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$identityType = [System.Security.Principal.SecurityIdentifier]
$old = Get-Acl -LiteralPath $path
if ($old.GetOwner($identityType).Value -ne $sid.Value) { throw 'Host metadata belongs to another user' }
if ($env:BRAINSTRIKE_LEASE_ACL_ACTION -eq 'set') {
  if ($kind -eq 'directory') {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $path -AclObject $acl
}
$checked = Get-Acl -LiteralPath $path
$rules = @($checked.GetAccessRules($true, $true, $identityType) | ForEach-Object {
  [ordered]@{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights; type = $_.AccessControlType.ToString(); isInherited = $_.IsInherited; inheritance = [int]$_.InheritanceFlags; propagation = [int]$_.PropagationFlags }
})
[ordered]@{ ownerSid = $checked.GetOwner($identityType).Value; currentSid = $sid.Value; protected = $checked.AreAccessRulesProtected; rules = @($rules) } | ConvertTo-Json -Depth 4 -Compress
`;
const execute = promisify(execFile);
const runAcl: AclRunner = (environment) =>
  runWithTimeout(
    async (signal) => {
      const result = await execute(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        {
          encoding: 'utf8',
          env: { ...process.env, ...environment },
          maxBuffer: 32_768,
          signal,
          windowsHide: true,
        }
      );
      return result.stdout;
    },
    { onTimeout: () => new Error('Windows host privacy command timed out'), timeoutMs: 5000 }
  );

export async function windowsPrivateAcl(
  path: string,
  kind: AclKind,
  action: AclAction,
  runner: AclRunner = runAcl
): Promise<void> {
  const acl = decodeAcl(
    JSON.parse(
      await runner({
        ['BRAINSTRIKE_LEASE_ACL_ACTION']: action,
        ['BRAINSTRIKE_LEASE_ACL_KIND']: kind,
        ['BRAINSTRIKE_LEASE_ACL_PATH']: path,
      })
    )
  );
  const rule = acl.rules[0];
  if (
    !(
      acl.protected &&
      /^S-1-\d+(?:-\d+)+$/.test(acl.currentSid) &&
      acl.ownerSid === acl.currentSid &&
      acl.rules.length === 1 &&
      rule &&
      rule.sid === acl.currentSid &&
      rule.type === 'Allow' &&
      rule.rights === 2_032_127 &&
      !rule.isInherited &&
      rule.inheritance === (kind === 'directory' ? 3 : 0) &&
      rule.propagation === 0
    )
  ) {
    throw new Error('Host metadata Windows ACL must grant only its current user full control');
  }
}

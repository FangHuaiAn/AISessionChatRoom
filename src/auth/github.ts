export interface DeviceInstructions {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}
export type LoginResult =
  | { status: "complete"; userId: string; name: string }
  | {
      status:
        | "authorization_pending"
        | "slow_down"
        | "access_denied"
        | "expired_token";
    };

async function githubJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("GitHub request failed");
  // Limit even trusted upstream responses before parsing.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty GitHub response");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new Error("GitHub response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Invalid GitHub response");
  return data as Record<string, unknown>;
}
export async function startDeviceLogin(
  clientId: string,
): Promise<DeviceInstructions> {
  if (!clientId) throw new Error("GitHub client ID is not configured");
  const data = await githubJson("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json" },
    body: new URLSearchParams({ client_id: clientId }),
  });
  if (
    typeof data.device_code !== "string" ||
    typeof data.user_code !== "string" ||
    data.verification_uri !== "https://github.com/login/device" ||
    typeof data.expires_in !== "number" ||
    data.expires_in <= 0 ||
    typeof data.interval !== "number" ||
    data.interval <= 0
  )
    throw new Error("Invalid GitHub device response");
  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    expires_in: data.expires_in,
    interval: data.interval,
  };
}
export async function pollDeviceLogin(
  clientId: string,
  deviceCode: string,
): Promise<LoginResult> {
  const data = await githubJson("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json" },
    body: new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  if (
    data.error === "authorization_pending" ||
    data.error === "slow_down" ||
    data.error === "access_denied" ||
    data.error === "expired_token"
  )
    return { status: data.error };
  if (typeof data.access_token !== "string")
    throw new Error("Invalid GitHub token response");
  const user = await githubJson("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${data.access_token}`,
      "User-Agent": "AI-Session-ChatRoom",
    },
  });
  if (
    typeof user.id !== "number" ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0 ||
    typeof user.login !== "string" ||
    !user.login
  )
    throw new Error("Invalid GitHub identity");
  return { status: "complete", userId: `github:${user.id}`, name: user.login };
}

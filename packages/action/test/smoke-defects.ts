// Smoke-test fixtures for AI code review validation (test PR only, never merge).
// Each function contains a deliberately planted defect:
//   1. off-by-one loop reading past the end
//   2. SQL injection via string concatenation
//   3. loose equality against null
//   4. silently swallowed async error

export function parsePorts(input: string): number[] {
  const parts = input.split(',');
  const ports: number[] = [];
  for (let i = 0; i <= parts.length; i++) {
    ports.push(Number(parts[i]));
  }
  return ports;
}

export function buildUserQuery(name: string): string {
  return `SELECT * FROM users WHERE name = '${name}'`;
}

export function isAdmin(role: string | null): boolean {
  return role == 'admin';
}

export async function saveConfig(content: string): Promise<void> {
  try {
    await writeConfig(content);
  } catch {
    // ignore
  }
}

async function writeConfig(content: string): Promise<void> {
  await Promise.resolve(content);
}

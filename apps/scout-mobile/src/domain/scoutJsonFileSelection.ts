export interface ScoutJsonFileMetadata {
  name: string;
  size: number;
  type?: string | null;
}

export function isAcceptableScoutJsonFile(
  file: ScoutJsonFileMetadata
): boolean {
  const validName =
    file.name.toLowerCase().endsWith('.json') ||
    (file.name.startsWith('msf:') &&
      file.type === 'application/json');

  return validName &&
    Number.isSafeInteger(file.size) &&
    file.size >= 1 &&
    file.size <= 131072;
}

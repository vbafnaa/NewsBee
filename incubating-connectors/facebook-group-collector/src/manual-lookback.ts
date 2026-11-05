export type ManualLookbackHours = 1 | 168 | 720;

export function manualLookbackHours(value: Record<string, unknown>): ManualLookbackHours {
  if (Object.keys(value).some(key => key !== 'lookbackHours') || (value.lookbackHours !== undefined && value.lookbackHours !== 1 && value.lookbackHours !== 168 && value.lookbackHours !== 720)) {
    throw new Error('Manual runs support 1 hour, 7 days, or 30 days');
  }
  return (value.lookbackHours ?? 1) as ManualLookbackHours;
}

export async function shouldUseCoordinator({ onlineSupports, ready, pushEnabled, checkPushAvailability }) {
  if (onlineSupports) return true;
  if (!ready || !pushEnabled) return false;
  return (await checkPushAvailability()) === true;
}

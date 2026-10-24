import { useDemoDevice } from '../demo/useDemoDevice'
import { useTwilioDevice } from './useTwilioDevice'

// The demo build swaps the Twilio device for a simulated one; the components can't tell them apart.
export const useDevice: typeof useTwilioDevice = __DEMO__ ? useDemoDevice : useTwilioDevice

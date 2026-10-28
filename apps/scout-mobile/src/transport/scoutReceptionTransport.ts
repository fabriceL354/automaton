import { createDemoResearchMessage } from '../../../../src/agent/research-reception';

/** Pull-only port: no arguments, outgoing payload, commands or acknowledgements. */
export interface ReadOnlyResearchTransport {
  readonly mode: 'SIMULATED' | 'HTTPS_DISABLED';
  receive(): Promise<string>;
}

export const demoResearchTransport: ReadOnlyResearchTransport = {
  mode: 'SIMULATED',
  async receive() {
    return JSON.stringify(createDemoResearchMessage());
  }
};

/** Future adapter boundary only: deliberately no URL, credentials or fetch. */
export const disabledHttpsResearchTransport: ReadOnlyResearchTransport = {
  mode: 'HTTPS_DISABLED',
  async receive() {
    throw new Error('SCOUT_HTTPS_NOT_CONFIGURED');
  }
};

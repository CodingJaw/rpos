import { Utils } from './utils';
import clc = require('cli-color');

const utils = Utils.utils;

export class IOState {
  digitalInputs: boolean[];
  digitalOutputs: boolean[];

  private inputListeners: ((index: number, value: boolean) => void)[];
  private outputListeners: ((index: number, value: boolean) => void)[];

  constructor(inputCount = 4, outputCount = 4) {
    this.digitalInputs = Array.from({ length: inputCount }, () => false);
    this.digitalOutputs = Array.from({ length: outputCount }, () => false);

    this.inputListeners = [];
    this.outputListeners = [];
  }

  getInput(index: number): boolean {
    this.assertIndex(index, this.digitalInputs.length);
    return this.digitalInputs[index];
  }

  setInput(index: number, value: boolean): void {
    this.assertIndex(index, this.digitalInputs.length);
    if (this.digitalInputs[index] === value) return;
    this.digitalInputs[index] = value;
    utils.log.debug(
      'Digital input %s set to %s',
      clc.cyanBright(`#${index}`),
      value ? clc.greenBright('ON') : clc.redBright('OFF')
    );
    this.inputListeners.forEach((listener) => listener(index, value));
  }

  getOutput(index: number): boolean {
    this.assertIndex(index, this.digitalOutputs.length);
    return this.digitalOutputs[index];
  }

  setOutput(index: number, value: boolean): void {
    this.assertIndex(index, this.digitalOutputs.length);
    if (this.digitalOutputs[index] === value) return;
    this.digitalOutputs[index] = value;
    utils.log.debug(
      'Digital output %s set to %s',
      clc.magentaBright(`#${index}`),
      value ? clc.greenBright('ON') : clc.redBright('OFF')
    );
    this.outputListeners.forEach((listener) => listener(index, value));
  }

  onInputChange(cb: (index: number, value: boolean) => void): void {
    this.inputListeners.push(cb);
  }

  onOutputChange(cb: (index: number, value: boolean) => void): void {
    this.outputListeners.push(cb);
  }

  private assertIndex(index: number, length: number) {
    if (index < 0 || index >= length) {
      throw new RangeError(`Index ${index} is out of bounds for length ${length}`);
    }
  }
}

export default IOState;

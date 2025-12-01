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

export class Greeter {
  private names: string[] = [];

  open(): void {
    this.names = [];
  }

  greet(name: string): string {
    this.names.push(name);
    return `hello ${name}`;
  }

  close(): number {
    return this.names.length;
  }
}

export class LoudGreeter extends Greeter {
  constructor(private readonly ending: string) {
    super();
    this.open();
  }

  override greet(name: string): string {
    return `${super.greet(name)}${this.ending}`;
  }
}

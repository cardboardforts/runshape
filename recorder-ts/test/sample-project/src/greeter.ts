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

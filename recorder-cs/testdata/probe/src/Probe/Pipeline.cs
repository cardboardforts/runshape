namespace Probe;

public sealed class Counter
{
    private int _count;

    public void Tick()
    {
        _count++;
    }

    public int Value => _count;
}

/// <summary>Async work, work handed to the thread pool, an iterator, and a throw: what the recorder must place.</summary>
public sealed class Pipeline
{
    private readonly Counter _counter;

    public Pipeline(Counter counter)
    {
        _counter = counter;
    }

    public async Task<int> RunAsync(int ticks)
    {
        await Task.Yield();
        await Task.Run(() => Step());
        for (var i = 0; i < ticks; i++) _counter.Tick();
        return _counter.Value;
    }

    private int Step()
    {
        return 1;
    }

    public IEnumerable<int> Evens(int upTo)
    {
        for (var i = 0; i < upTo; i += 2) yield return Twice(i) / 2;
    }

    private static int Twice(int x) => x * 2;

    public void Explode() => throw new InvalidOperationException("boom");
}

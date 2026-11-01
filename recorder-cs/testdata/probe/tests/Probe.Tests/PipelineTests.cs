using Probe;
using Xunit;

namespace Probe.Tests;

public class PipelineTests
{
    [Fact]
    public async Task Runs_async_work_under_its_caller()
    {
        var pipeline = new Pipeline(new Counter());
        Assert.Equal(60, await pipeline.RunAsync(60));
    }

    [Fact]
    public void Iterates()
    {
        Assert.Equal(6, new Pipeline(new Counter()).Evens(6).Sum());
    }

    [Fact]
    public void Fails()
    {
        new Pipeline(new Counter()).Explode();
    }
}

using System.ServiceModel;

namespace Agency.Intake
{
    [ServiceContract]
    public interface IIntakeStatus
    {
        [OperationContract]
        string GetStatus(int caseId);

        [OperationContract]
        int CountOpen(string caseType);
    }
}

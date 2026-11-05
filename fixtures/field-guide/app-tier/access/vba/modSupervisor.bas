Attribute VB_Name = "modSupervisor"
Option Compare Database

Public Function fnPriorityBand(days As Variant) As String
    If days > 60 Then fnPriorityBand = "HIGH" Else fnPriorityBand = "STANDARD"
End Function

Public Sub CloseStale()
    CurrentDb.Execute "UPDATE dbo_Intake SET Status = 'CLOSED' " & _
        "WHERE DaysWaiting > 180", dbFailOnError
End Sub

Public Sub ExportFor(ByVal caseType As String)
    Dim rs As DAO.Recordset
    Set rs = CurrentDb.OpenRecordset("SELECT CaseId FROM dbo_Intake WHERE CaseType = '" & caseType & "'")
End Sub
